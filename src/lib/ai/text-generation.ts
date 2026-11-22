import { z, type ZodType, type ZodTypeDef } from 'zod';
import {
  getOpenAI, aiConfig, withTimeout, recordUsage, assertAiBudget, clampCompletionTokens, estimateCostUsd,
} from './provider';
import { aiBackend, aiPolicy, agnesConfigured, huggingFaceConfigured, isExplicitAgnesModel, isExplicitHuggingFaceModel } from './config';
import { generateStructuredHuggingFace, generateTextHuggingFace } from './hf-text-generation';
import { generateStructuredAgnes, generateTextAgnes } from './agnes-generation';
import type { ChatMessage } from '@/types';
import 'server-only';

/**
 * Where a piece of generated output actually came from.
 *
 * - `agnes`       — a real Agnes AI response (the primary provider).
 * - `huggingface` — a real response from a Hugging Face hosted model (possibly
 *                   a different model than requested: `actualModel` records it,
 *                   and `fallbackUsed` distinguishes that from a stub).
 * - `openai`      — a real OpenAI response.
 * - `demo`        — deliberate demo mode (no API key, or AI_DEMO_MODE=true).
 * - `fallback`    — a real request was attempted and the stub was substituted
 *                   because every provider failed or the structured output could
 *                   not be parsed. `fallbackReason` explains why, and callers
 *                   are expected to surface/log it rather than treat the output
 *                   as real. Chapter generation refuses this substitution.
 */
export type GenerationSource = 'agnes' | 'huggingface' | 'openai' | 'demo' | 'fallback';

export interface GenerationMeta {
  source: GenerationSource;
  model: string;
  usedFallback: boolean;
  fallbackReason?: string;
  /** The model that actually produced the output (differs from `model` when a
   *  task-compatible fallback model was used). */
  actualModel?: string;
  /** True when a different model than requested produced the output. */
  modelFallbackUsed?: boolean;
  provider?: string;
  attempts?: number;
  latencyMs?: number;
}

/** True when hosted Hugging Face inference should serve this request. */
export function huggingFaceBackendActive(): boolean {
  return aiBackend() === 'huggingface';
}

/** True when Agnes AI (the primary provider) should serve this request. */
export function agnesBackendActive(): boolean {
  return aiBackend() === 'agnes';
}

/**
 * True when a real hosted provider (Agnes primary, Hugging Face fallback) can
 * serve hosted inference. The direct generation endpoints gate on this.
 * Forced demo mode (`AI_DEMO_MODE=true`) suppresses every paid call, so the
 * hosted backends are never active while it is on — even with a key set.
 */
export function hostedBackendActive(): boolean {
  if (aiConfig.forcedDemo) return false;
  return agnesBackendActive() || huggingFaceBackendActive();
}

/**
 * True when this deployment is a demo deployment: either `AI_DEMO_MODE=true`
 * (explicit) or no provider key of any kind is configured. Demo prose is only
 * ever substituted on demo deployments; a deployment with a provider key that
 * cannot serve *this* request gets a precise configuration error instead of
 * silently writing placeholder text into the author's story.
 */
function isDemoDeployment(): boolean {
  return aiConfig.forcedDemo || aiBackend() === 'demo';
}

/** Explains which credential is missing for the requested model path. */
function missingProviderMessage(model?: string): string {
  if (model && isExplicitHuggingFaceModel(model)) {
    return `The selected model "${model}" is served by Hugging Face, but HF_TOKEN is not configured on the server. Choose "auto" or an Agnes AI model, or set HF_TOKEN.`;
  }
  if (model && isExplicitAgnesModel(model)) {
    return `The selected model "${model}" is served by Agnes AI, but AGNES_API_KEY is not configured on the server. Choose "auto" or set AGNES_API_KEY.`;
  }
  return 'No AI provider can serve this request. Set AGNES_API_KEY (primary), HF_TOKEN (fallback) or OPENAI_API_KEY on the server.';
}

/**
 * True when the Hugging Face fallback chain is reachable: either it is the
 * active backend or it is configured as the fallback behind Agnes.
 */
function huggingFaceFallbackAvailable(): boolean {
  return huggingFaceConfigured();
}

export interface TextResult { text: string; meta: GenerationMeta }
export interface StructuredResult<T> { data: T; meta: GenerationMeta }

/** A provider the caller can pin explicitly. */
export type ForcedProvider = 'agnes' | 'huggingface' | 'openai';

function modelConflictsWithProvider(model: string | undefined, provider: ForcedProvider | undefined): boolean {
  if (!provider || !model || model === 'auto') return false;
  if (provider === 'agnes') return !isExplicitAgnesModel(model);
  if (provider === 'huggingface') return !isExplicitHuggingFaceModel(model);
  return isExplicitAgnesModel(model) || isExplicitHuggingFaceModel(model);
}

export interface GenerateTextInput {
  onText?: (text: string) => void;
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  userId: string;
  novelId?: string;
  chapterId?: string;
  jobId?: string;
  taskType: string;
  signal?: AbortSignal;
  /**
   * Pins the request to exactly one provider: no *implicit* cross-provider
   * fallback happens inside this function when it is set. Callers that want a
   * fallback chain (the universal engine) walk the chain themselves, so the
   * persisted provenance always names the provider that actually ran instead of
   * silently switching. `allowFallbackOnError`/demo substitution is still
   * honoured when explicitly requested.
   */
  forceProvider?: ForcedProvider;
  /** When true (default) a provider failure rethrows so the caller decides. */
  allowFallbackOnError?: boolean;
  /**
   * Hugging Face backend: allow another *eligible hosted model* to serve the
   * request when the requested/selected one fails. This is a real generation by
   * a different model (recorded in `meta.actualModel`), not a stub substitute.
   */
  allowModelFallback?: boolean;
  /** Original request when an outer provider chain is trying a fallback. */
  provenance?: { requestedModelId: string; fallbackUsed: boolean };
  /** Used only when `allowFallbackOnError` is true; defaults to demo prose. */
  fallbackText?: string;
}

export function isRetryableProviderError(err: unknown): boolean {
  const anyErr = err as any;
  if (anyErr?.name === 'AbortError' || anyErr?.code === 'ai_budget_exhausted') return false;
  const status = typeof anyErr?.status === 'number' ? anyErr.status : undefined;
  if (status && [400, 401, 402, 403, 404, 422].includes(status)) return false;
  if (status === 429 || (status && status >= 500)) return true;
  const msg = errorMessage(err);
  if (/invalid api key|incorrect api key|unauthorized|forbidden|bad request/i.test(msg)) return false;
  if (/timed out|rate limit|429|502|503|504|econnreset|socket hang up|temporarily unavailable/i.test(msg)) return true;
  return false;
}

async function sleepWithJitter(attempt: number, baseMs = 250): Promise<void> {
  const exp = Math.min(4000, baseMs * 2 ** attempt);
  const jitter = Math.floor(Math.random() * Math.max(50, Math.round(exp * 0.25)));
  await new Promise(resolve => setTimeout(resolve, exp + jitter));
}

export { isExplicitAgnesModel, isExplicitHuggingFaceModel };

/** Chat completion that returns plain text plus provenance. */
export async function generateTextDetailed(input: GenerateTextInput): Promise<TextResult> {
  // ── Agnes AI: the primary provider ────────────────────────────────────────
  // An explicit Hugging Face repo id overrides the default provider (the user
  // chose that model on purpose); everything else goes to Agnes first.
  const forced = input.forceProvider;
  let emittedText = false;
  const onText = input.onText ? (text: string) => {
    if (text) emittedText = true;
    input.onText?.(text);
  } : undefined;
  const explicitHfModel = isExplicitHuggingFaceModel(input.model);
  const tryAgnes = forced ? forced === 'agnes' : true;
  let agnesFailure: string | undefined;
  let hfChainRequested = forced
    ? forced === 'huggingface'
    : huggingFaceBackendActive() || (huggingFaceFallbackAvailable() && explicitHfModel);
  // AI_DEMO_MODE=true performs no paid calls anywhere, even with a key set.
  if (aiConfig.forcedDemo) hfChainRequested = false;

  if (!isDemoDeployment() && modelConflictsWithProvider(input.model, forced) && (input.allowModelFallback === false || !aiPolicy().fallbackEnabled)) {
    throw Object.assign(new Error('The selected model is not supported by the requested provider.'), { code: 'provider_model_mismatch', retryable: false });
  }
  if (!isDemoDeployment() && forced === 'agnes' && !agnesConfigured()) {
    throw Object.assign(new Error('Agnes AI was requested but AGNES_API_KEY is not configured.'), { code: 'provider_not_configured', retryable: false });
  }
  if (!isDemoDeployment() && forced === 'huggingface' && !huggingFaceFallbackAvailable()) {
    throw Object.assign(new Error('Hugging Face was requested but HF_TOKEN is not configured.'), { code: 'provider_not_configured', retryable: false });
  }
  if (!forced && isExplicitAgnesModel(input.model) && !agnesConfigured() && !isDemoDeployment()) {
    const reason = missingProviderMessage(input.model);
    if (input.allowModelFallback !== false && aiPolicy().fallbackEnabled && huggingFaceFallbackAvailable()) {
      agnesFailure = reason;
      hfChainRequested = true;
    } else if (input.allowFallbackOnError) {
      return { text: input.fallbackText ?? demoTextResponse(input.messages), meta: { source: 'fallback', model: input.model || 'auto', usedFallback: true, fallbackReason: reason } };
    } else {
      throw Object.assign(new Error(reason), { status: 503, code: 'provider_not_configured', retryable: false });
    }
  }

  if (tryAgnes && (agnesBackendActive() || (isExplicitAgnesModel(input.model) && agnesConfigured()) || (forced === 'agnes' && agnesConfigured())) && (!explicitHfModel || forced === 'agnes') && !aiConfig.forcedDemo) {
    try {
      const result = await generateTextAgnes({
        messages: input.messages,
        ...(isExplicitAgnesModel(input.model) ? { model: input.model } : {}),
        temperature: input.temperature ?? 0.8,
        maxTokens: input.maxTokens,
        userId: input.userId,
        novelId: input.novelId,
        chapterId: input.chapterId,
        jobId: input.jobId,
        taskType: input.taskType,
        signal: input.signal,
        onText,
      });
      return {
        text: result.text,
        meta: {
          source: 'agnes',
          model: result.model,
          usedFallback: false,
          actualModel: result.model,
          modelFallbackUsed: forced === 'agnes' && !!input.model && input.model !== 'auto' && !isExplicitAgnesModel(input.model),
          provider: result.provider,
          attempts: result.attempts,
          latencyMs: result.latencyMs,
        },
      };
    } catch (err) {
      // Never mix a partially streamed answer with a second provider or stub.
      if (emittedText || input.signal?.aborted) throw err;
      agnesFailure = errorMessage(err);
      // A pinned provider or disabled fallback never silently switches.
      if (forced || input.allowModelFallback === false || !aiPolicy().fallbackEnabled || !huggingFaceFallbackAvailable()) {
        // The caller decides whether a labelled placeholder is acceptable.
        if (input.allowFallbackOnError) {
          console.warn(`[ai] ${input.taskType}: Agnes AI generation failed, using labelled fallback — ${agnesFailure}`);
          return {
            text: input.fallbackText ?? demoTextResponse(input.messages),
            meta: {
              source: 'fallback',
              model: input.model || 'auto',
              usedFallback: true,
              fallbackReason: agnesFailure,
            },
          };
        }
        throw err;
      }
      hfChainRequested = true;
      console.warn(`[ai] ${input.taskType}: Agnes AI generation failed, falling back to Hugging Face — ${agnesFailure}`);
    }
  }

  // ── Hugging Face hosted inference (with task-compatible fallback) ─────────
  // Either the active backend, an explicitly requested HF model, or the
  // fallback chain behind Agnes.
  if (hfChainRequested) {
    try {
      const result = await generateTextHuggingFace({
        messages: input.messages,
        // Only HF repository ids can be selected in the HF registry; an Agnes
        // model that failed above must not be treated as an HF repository.
        ...(explicitHfModel ? { model: input.model } : {}),
        temperature: input.temperature ?? 0.8,
        maxTokens: input.maxTokens,
        userId: input.userId,
        novelId: input.novelId,
        chapterId: input.chapterId,
        jobId: input.jobId,
        taskType: input.taskType,
        signal: input.signal,
        onText,
        allowFallback: input.allowModelFallback !== false,
        ...((input.provenance?.fallbackUsed || agnesFailure || (forced === 'huggingface' && input.model && input.model !== 'auto' && !explicitHfModel))
          ? { provenance: { requestedModelId: input.provenance?.requestedModelId || input.model || 'auto', fallbackUsed: true } }
          : {}),
        deduplicate: true,
      });
      if (!result.text.trim()) throw new Error('The model returned an empty response.');
      return {
        text: result.text,
        meta: {
          source: 'huggingface',
          model: result.model,
          usedFallback: false,
          actualModel: result.model,
          modelFallbackUsed: result.fallbackUsed,
          provider: result.provider,
          attempts: result.attempts,
          latencyMs: result.latencyMs,
        },
      };
    } catch (err) {
      // Do not replace already streamed provider text with a placeholder.
      if (emittedText || input.signal?.aborted) throw err;
      // Interactive editing and chapters must never silently receive stub
      // prose: a real failure is reported so the caller can retry.
      if (input.allowFallbackOnError) {
        const reason = agnesFailure ? `Agnes AI: ${agnesFailure}; Hugging Face: ${errorMessage(err)}` : errorMessage(err);
        console.warn(`[ai] ${input.taskType}: hosted generation failed, using labelled fallback — ${reason}`);
        return {
          text: input.fallbackText ?? demoTextResponse(input.messages),
          meta: {
            source: 'fallback',
            model: input.model || 'auto',
            usedFallback: true,
            fallbackReason: reason,
          },
        };
      }
      throw err;
    }
  }

  // An unavailable explicit HF request must not be routed to OpenAI or
  // presented as demo output just because another provider is configured.
  if (!forced && explicitHfModel && !huggingFaceFallbackAvailable() && !isDemoDeployment()) {
    const reason = missingProviderMessage(input.model);
    if (input.allowFallbackOnError) {
      return { text: input.fallbackText ?? demoTextResponse(input.messages), meta: { source: 'fallback', model: input.model || 'auto', usedFallback: true, fallbackReason: reason } };
    }
    throw Object.assign(new Error(reason), { status: 503, code: 'provider_not_configured', retryable: false });
  }

  const client = getOpenAI();
  const requestedOpenAiModel = input.model && input.model !== 'auto' && !(forced === 'openai' && (isExplicitAgnesModel(input.model) || explicitHfModel))
    ? input.model : undefined;
  const model = requestedOpenAiModel || aiConfig.textModel;
  if (!client) {
    if (forced === 'openai' && !input.allowFallbackOnError) {
      throw Object.assign(
        new Error('OpenAI was requested but OPENAI_API_KEY is not configured on the server.'),
        { status: 400, code: 'provider_not_configured', retryable: false },
      );
    }
    if (isDemoDeployment()) {
      // Demo deployment (AI_DEMO_MODE=true, or no provider key at all): the
      // result is labelled `source: 'demo'` (and persisted with
      // generationSource='demo'), so it never claims to be a provider
      // response. Chapter generation applies its own, stricter gate: it only
      // accepts demo text when the deployment explicitly opted in with
      // AI_DEMO_MODE=true and no key is configured.
      return {
        text: input.fallbackText ?? demoTextResponse(input.messages),
        meta: { source: 'demo', model, usedFallback: false },
      };
    }
    // A provider key exists, but not one that can serve this request (e.g. an
    // explicitly selected Hugging Face model with no HF_TOKEN). Never
    // substitute placeholder prose into a deployment that can write real text:
    // tolerant callers get a labelled fallback, everyone else gets a precise
    // configuration error naming what is missing.
    const reason = missingProviderMessage(input.model);
    if (input.allowFallbackOnError) {
      console.warn(`[ai] ${input.taskType}: ${reason} Using labelled fallback.`);
      return {
        text: input.fallbackText ?? demoTextResponse(input.messages),
        meta: { source: 'fallback', model: input.model || 'auto', usedFallback: true, fallbackReason: reason },
      };
    }
    throw Object.assign(new Error(reason), {
      status: 503,
      code: 'provider_not_configured',
      retryable: false,
    });
  }

  const maxTokens = clampCompletionTokens(input.maxTokens);
  const estPrompt = estimatePromptTokens(input.messages);
  assertAiBudget(input.userId, estPrompt + maxTokens);
  const estimatedCostBeforeUsd = estimateCostUsd(model, estPrompt, Math.round(maxTokens * 0.6));

  let lastErr: unknown;
  const maxAttempts = Math.max(1, Math.min(aiConfig.maxRetries + 1, 4));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (input.signal?.aborted) throw new Error('Generation request was cancelled.');
      onText?.('');
      const resp = onText ? await (async () => {
        const stream = await client.chat.completions.create({
          model, messages: input.messages, temperature: input.temperature ?? 0.8,
          max_tokens: maxTokens, stream: true, stream_options: { include_usage: true },
        }, { timeout: aiConfig.timeoutMs, signal: input.signal });
        let text = '';
        let usage;
        let reportedModel = model;
        for await (const part of stream) {
          if (part.usage) usage = part.usage;
          if (part.model) reportedModel = part.model;
          const delta = part.choices[0]?.delta?.content;
          if (delta) { text += delta; onText(text); }
        }
        return { choices: [{ message: { content: text } }], usage, model: reportedModel };
      })() : await withTimeout(
        client.chat.completions.create({
          model,
          messages: input.messages,
          temperature: input.temperature ?? 0.8,
          max_tokens: maxTokens,
        }, { timeout: aiConfig.timeoutMs, signal: input.signal }),
        aiConfig.timeoutMs,
        `text generation (${input.taskType})`,
      );
      const text = resp.choices[0]?.message?.content || '';
      const usage = resp.usage;
      const actualModel = resp.model || model;
      recordUsage({
        userId: input.userId,
        novelId: input.novelId,
        chapterId: input.chapterId,
        jobId: input.jobId,
        taskType: input.taskType,
        model: actualModel,
        promptTokens: usage?.prompt_tokens ?? estPrompt,
        completionTokens: usage?.completion_tokens ?? estimateCompletionTokens(text),
        estimatedCostBeforeUsd,
        source: 'openai',
      });
      return { text, meta: { source: 'openai', model: actualModel, actualModel, provider: 'openai', usedFallback: false, modelFallbackUsed: forced === 'openai' && (isExplicitAgnesModel(input.model) || explicitHfModel) } };
    } catch (err) {
      lastErr = err;
      if (!emittedText && !input.signal?.aborted && attempt + 1 < maxAttempts && isRetryableProviderError(err)) {
        await sleepWithJitter(attempt);
        continue;
      }
      break;
    }
  }

  const reason = errorMessage(lastErr);
  if (emittedText || input.signal?.aborted || !input.allowFallbackOnError) throw lastErr;
  console.warn(`[ai] ${input.taskType}: provider call failed, using labelled fallback — ${reason}`);
  recordUsage({
    userId: input.userId,
    novelId: input.novelId,
    chapterId: input.chapterId,
    jobId: input.jobId,
    taskType: `${input.taskType}:fallback`,
    model,
    promptTokens: 0,
    completionTokens: 0,
    estimatedCostBeforeUsd,
    source: 'stub',
    meta: { reason },
  });
  return {
    text: input.fallbackText ?? demoTextResponse(input.messages),
    meta: { source: 'fallback', model, usedFallback: true, fallbackReason: reason },
  };
}

/** Backwards-compatible wrapper returning just the text. */
export async function generateText(input: GenerateTextInput): Promise<string> {
  return (await generateTextDetailed(input)).text;
}

export interface GenerateStructuredInput<T> {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  userId: string;
  novelId?: string;
  chapterId?: string;
  jobId?: string;
  taskType: string;
  signal?: AbortSignal;
  /** Deterministic demo/stub value used in demo mode or after parse failures. */
  fallback: T;
  /** Pin one provider; an outer orchestrator may choose whether to try another. */
  forceProvider?: ForcedProvider;
  /** Allow another eligible hosted model to serve the request (HF backend). */
  allowModelFallback?: boolean;
  /** Original request when an outer provider chain is trying a fallback. */
  provenance?: { requestedModelId: string; fallbackUsed: boolean };
  /** Total provider attempts before the fallback is returned (default 2). */
  retries?: number;
}

/**
 * Chat completion with JSON output enforced by a Zod schema.
 *
 * Returns provenance alongside the value so callers can tell a real result from
 * the fallback; nothing is silently presented as genuine AI output.
 */
export async function generateStructuredDetailed<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  input: GenerateStructuredInput<T>,
): Promise<StructuredResult<T>> {
  // ── Agnes AI: the primary provider ────────────────────────────────────────
  const forced = input.forceProvider;
  const explicitHfModel = isExplicitHuggingFaceModel(input.model);
  const explicitAgnesModel = isExplicitAgnesModel(input.model);
  let agnesFailure: string | undefined;
  let hfChainRequested = forced
    ? forced === 'huggingface'
    : huggingFaceBackendActive() || (huggingFaceFallbackAvailable() && explicitHfModel);
  // AI_DEMO_MODE=true performs no paid calls anywhere, even with a key set.
  if (aiConfig.forcedDemo) hfChainRequested = false;

  if (!isDemoDeployment() && modelConflictsWithProvider(input.model, forced) && (input.allowModelFallback === false || !aiPolicy().fallbackEnabled)) {
    return { data: input.fallback, meta: { source: 'fallback', model: input.model || 'auto', usedFallback: true, fallbackReason: 'The selected model is not supported by the requested provider.' } };
  }
  if (!isDemoDeployment() && ((forced === 'agnes' && !agnesConfigured()) || (forced === 'huggingface' && !huggingFaceFallbackAvailable()) || (forced === 'openai' && !aiConfig.hasApiKey))) {
    const reason = `${forced === 'agnes' ? 'Agnes AI' : forced === 'huggingface' ? 'Hugging Face' : 'OpenAI'} was requested but is not configured.`;
    return { data: input.fallback, meta: { source: 'fallback', model: input.model || 'auto', usedFallback: true, fallbackReason: reason } };
  }
  if (!forced && explicitAgnesModel && !agnesConfigured() && !isDemoDeployment()) {
    const reason = missingProviderMessage(input.model);
    if (input.allowModelFallback !== false && aiPolicy().fallbackEnabled && huggingFaceFallbackAvailable()) {
      agnesFailure = reason;
      hfChainRequested = true;
    } else {
      return { data: input.fallback, meta: { source: 'fallback', model: input.model || 'auto', usedFallback: true, fallbackReason: reason } };
    }
  }
  if (!forced && explicitHfModel && !huggingFaceFallbackAvailable() && !isDemoDeployment()) {
    const reason = missingProviderMessage(input.model);
    return { data: input.fallback, meta: { source: 'fallback', model: input.model || 'auto', usedFallback: true, fallbackReason: reason } };
  }

  const tryAgnes = forced
    ? forced === 'agnes' && agnesConfigured()
    : (agnesBackendActive() || (explicitAgnesModel && agnesConfigured())) && !explicitHfModel;
  if (tryAgnes && !aiConfig.forcedDemo) {
    try {
      const { data, meta } = await generateStructuredAgnes<T>({
        schema,
        messages: input.messages,
        ...(isExplicitAgnesModel(input.model) ? { model: input.model } : {}),
        temperature: input.temperature ?? 0.4,
        maxTokens: 4_096,
        userId: input.userId,
        novelId: input.novelId,
        chapterId: input.chapterId,
        jobId: input.jobId,
        taskType: input.taskType,
        signal: input.signal,
      });
      return {
        data,
        meta: {
          source: 'agnes',
          model: meta.model,
          usedFallback: false,
          actualModel: meta.model,
          modelFallbackUsed: input.provenance?.fallbackUsed === true || (forced === 'agnes' && !!input.model && input.model !== 'auto' && !explicitAgnesModel),
          provider: meta.provider,
          attempts: meta.attempts,
          latencyMs: meta.latencyMs,
        },
      };
    } catch (err) {
      agnesFailure = errorMessage(err);
      if (forced || input.allowModelFallback === false || !aiPolicy().fallbackEnabled || !huggingFaceFallbackAvailable()) {
        // Structured output is never invented: an unusable response is a
        // failure and the caller decides (outline/premise generation aborts,
        // so no placeholder content is written into the author's story).
        console.warn(`[ai] ${input.taskType}: Agnes AI structured generation failed — ${agnesFailure}`);
        return {
          data: input.fallback,
          meta: { source: 'fallback', model: input.model || 'auto', usedFallback: true, fallbackReason: agnesFailure },
        };
      }
      hfChainRequested = true;
      console.warn(`[ai] ${input.taskType}: Agnes AI structured generation failed, falling back to Hugging Face — ${agnesFailure}`);
    }
  }

  // ── Hugging Face hosted inference (with task-compatible fallback) ─────────
  if (hfChainRequested) {
    try {
      const { data, meta } = await generateStructuredHuggingFace<T>({
        schema,
        messages: input.messages,
        ...(explicitHfModel ? { model: input.model } : {}),
        temperature: input.temperature ?? 0.4,
        userId: input.userId,
        novelId: input.novelId,
        chapterId: input.chapterId,
        jobId: input.jobId,
        taskType: input.taskType,
        signal: input.signal,
        allowFallback: input.allowModelFallback !== false,
        ...((input.provenance?.fallbackUsed || agnesFailure || (forced === 'huggingface' && input.model && input.model !== 'auto' && !explicitHfModel))
          ? { provenance: { requestedModelId: input.provenance?.requestedModelId || input.model || 'auto', fallbackUsed: true } }
          : {}),
      });
      return {
        data,
        meta: {
          source: 'huggingface',
          model: meta.model,
          usedFallback: false,
          actualModel: meta.model,
          modelFallbackUsed: meta.fallbackUsed,
          provider: meta.provider,
          attempts: meta.attempts,
          latencyMs: meta.latencyMs,
        },
      };
    } catch (err) {
      const reason = agnesFailure ? `Agnes AI: ${agnesFailure}; Hugging Face: ${errorMessage(err)}` : errorMessage(err);
      // Structured output is never invented: an unusable response is a failure
      // and the caller decides (outline/premise generation aborts, so no
      // placeholder content is written into the author's story).
      console.warn(`[ai] ${input.taskType}: hosted structured generation failed — ${reason}`);
      return {
        data: input.fallback,
        meta: { source: 'fallback', model: input.model || 'auto', usedFallback: true, fallbackReason: reason },
      };
    }
  }

  const client = getOpenAI();
  const useDefaultOpenAiModel = forced === 'openai' && (explicitAgnesModel || explicitHfModel);
  const model = input.model && input.model !== 'auto' && !useDefaultOpenAiModel ? input.model : aiConfig.structuredModel;
  if (!client) {
    if (isDemoDeployment()) return { data: input.fallback, meta: { source: 'demo', model, usedFallback: false } };
    const reason = missingProviderMessage(input.model);
    return { data: input.fallback, meta: { source: 'fallback', model, usedFallback: true, fallbackReason: reason } };
  }

  const attempts = Math.max(1, Math.min(input.retries ?? 2, 4));
  const estPrompt = estimatePromptTokens(input.messages);
  assertAiBudget(input.userId, estPrompt + 2000);
  const estimatedCostBeforeUsd = estimateCostUsd(model, estPrompt, 1500);
  const systemInject: ChatMessage = {
    role: 'system',
    content: 'You MUST respond only with valid JSON that matches the schema requested. No prose, no markdown, no code fences.',
  };

  let lastReason = 'unknown error';
  for (let attempt = 0; attempt < attempts; attempt++) {
    let raw = '{}';
    let actualModel = model;
    try {
      if (input.signal?.aborted) throw new Error('Generation request was cancelled.');
      const resp = await withTimeout(
        client.chat.completions.create({
          model,
          messages: [systemInject, ...input.messages],
          temperature: input.temperature ?? 0.4,
          response_format: { type: 'json_object' },
        }, { timeout: aiConfig.timeoutMs, signal: input.signal }),
        aiConfig.timeoutMs,
        `structured generation (${input.taskType})`,
      );
      raw = resp.choices[0]?.message?.content || '{}';
      actualModel = resp.model || model;
      const usage = resp.usage;
      recordUsage({
        userId: input.userId,
        novelId: input.novelId,
        chapterId: input.chapterId,
        jobId: input.jobId,
        taskType: input.taskType,
        model: actualModel,
        promptTokens: usage?.prompt_tokens ?? estPrompt,
        completionTokens: usage?.completion_tokens ?? estimateCompletionTokens(raw),
        estimatedCostBeforeUsd,
        source: 'openai',
      });
    } catch (err) {
      lastReason = errorMessage(err);
      console.warn(`[ai] ${input.taskType}: attempt ${attempt + 1}/${attempts} failed — ${lastReason}`);
      if (attempt + 1 < attempts && isRetryableProviderError(err)) {
        await sleepWithJitter(attempt);
      }
      continue;
    }

    try {
      const parsed = JSON.parse(extractJson(raw));
      const result = schema.safeParse(parsed);
      if (result.success) return { data: result.data, meta: { source: 'openai', model: actualModel, actualModel, provider: 'openai', usedFallback: false, modelFallbackUsed: input.provenance?.fallbackUsed === true || useDefaultOpenAiModel } };
      lastReason = `schema validation failed: ${result.error.errors[0]?.message ?? 'unknown'}`;
    } catch (err) {
      lastReason = `invalid JSON: ${errorMessage(err)}`;
    }
    console.warn(`[ai] ${input.taskType}: attempt ${attempt + 1}/${attempts} unusable — ${lastReason}`);
  }

  console.warn(`[ai] ${input.taskType}: all ${attempts} attempt(s) failed, returning labelled fallback — ${lastReason}`);
  recordUsage({
    userId: input.userId,
    novelId: input.novelId,
    chapterId: input.chapterId,
    jobId: input.jobId,
    taskType: `${input.taskType}:fallback`,
    model,
    promptTokens: 0,
    completionTokens: 0,
    estimatedCostBeforeUsd,
    source: 'stub',
    meta: { reason: lastReason, attempts },
  });
  return {
    data: input.fallback,
    meta: { source: 'fallback', model, usedFallback: true, fallbackReason: lastReason },
  };
}

/** Backwards-compatible wrapper returning just the value. */
export async function generateStructured<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  input: GenerateStructuredInput<T>,
): Promise<T> {
  return (await generateStructuredDetailed(schema, input)).data;
}

/** Streaming response (returns async iterator). For client-side progress. */
export async function* streamText(input: {
  messages: ChatMessage[]; model?: string; temperature?: number;
  userId: string; novelId?: string; taskType: string;
}): AsyncGenerator<string, void, unknown> {
  const client = getOpenAI();
  const model = input.model || aiConfig.textModel;
  if (!client) {
    const txt = demoTextResponse(input.messages);
    for (let i = 0; i < txt.length; i += 24) { yield txt.slice(i, i + 24); await new Promise(r => setTimeout(r, 10)); }
    return;
  }
  assertAiBudget(input.userId, estimatePromptTokens(input.messages) + 2000);
  const stream = await withTimeout(
    client.chat.completions.create({
      model, messages: input.messages, temperature: input.temperature ?? 0.8, stream: true,
    }, { timeout: aiConfig.timeoutMs }),
    aiConfig.timeoutMs,
    `stream (${input.taskType})`,
  );
  let completionTokens = 0;
  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content;
    if (delta) { completionTokens += estimateCompletionTokens(delta); yield delta; }
  }
  recordUsage({
    userId: input.userId, novelId: input.novelId, taskType: input.taskType, model,
    promptTokens: estimatePromptTokens(input.messages), completionTokens, source: 'openai',
  });
}

function extractJson(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenced) return fenced[1].trim();
  return raw.trim();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function estimatePromptTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) / 4);
}

function estimateCompletionTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

/** Deterministic demo response so developers can see UI flow without API keys. */
function demoTextResponse(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1]?.content || '';
  if (/chapter/i.test(last) && /word/i.test(last)) {
    return [
      'The rain had stopped by the time she reached the bridge, but the stones still glistened like old wounds.',
      'She pulled her collar higher and counted the arches—seven, just as the letter had said.',
      'Somewhere behind her, a door creaked open in a building that should have been empty for years.',
      '"You took your time," a voice said from the shadow of the pier.',
      'She did not turn. Not yet. Instead she watched the water drag a crumpled leaf toward the sea, and for the first time in twelve years she allowed herself to believe she might not have to do this alone.',
    ].join('\n\n');
  }
  if (/outline|chapter/i.test(last)) {
    return 'The hero crosses the threshold into the unknown. Allies appear, questions multiply, and the first thread of the central conflict is pulled.';
  }
  return 'The story deepens here. A new detail emerges, small but vital, that will echo in the chapters ahead.';
}

export { z };
