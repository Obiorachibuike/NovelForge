/**
 * Fallback orchestrator.
 *
 * One implementation drives both text and image generation:
 *
 *   select eligible models → attempt (bounded retries per model, circuit
 *   breakers, timeouts) → validate the output → fall back to the next
 *   task-compatible model → record usage, model health and job provenance.
 *
 * Guarantees:
 *  - Fallback candidates always share the requested task (an image request can
 *    never fall back to a text model).
 *  - The number of attempts is bounded by `AI_MAX_FALLBACK_ATTEMPTS` and
 *    `AI_MAX_RETRIES_PER_MODEL`; there is no unbounded loop.
 *  - Permanent errors (auth, gated, unsupported, paid-only under a free-only
 *    policy) are not retried on the same model and stop the chain when they
 *    apply to the whole request.
 *  - Both the requested and the actual model are always returned.
 */
import 'server-only';
import { isCircuitClosed, recordCircuitFailure, recordCircuitSuccess } from './circuit-breaker';
import { aiPolicy } from './config';
import { classifyAiError } from './error-classifier';
import { runWithRetries, withDeadline, type RetryPolicy } from './retry-policy';
import { explainNoEligibleModel, selectModels, type SelectionResult } from './model-selection';
import { getModelRow, recordModelFailure, recordModelSuccess } from './model-registry';
import { recordGenerationUsage, recordJobProvenance, costFor } from './usage-tracker';
import { HttpError } from '@/lib/api/http';
import type { AiErrorCategory, AiErrorInfo, GenerationCost, ModelRow, ModelTask, TextGenerationResult, ImageGenerationResult } from './types';

export interface AttemptRecord {
  modelId: string;
  provider?: string;
  category: AiErrorCategory | 'success';
  latencyMs: number;
  message?: string;
}

export interface OrchestratedResult<T> {
  ok: boolean;
  value?: T;
  requestedModelId: string;
  actualModelId?: string;
  provider?: string;
  fallbackUsed: boolean;
  attempts: number;
  latencyMs: number;
  attemptTrail: AttemptRecord[];
  selection: SelectionResult;
  error?: AiErrorInfo;
  usage?: { inputTokens?: number; outputTokens?: number };
  cost?: GenerationCost;
}

export interface OrchestrateOptions<T> {
  task: ModelTask;
  /** 'auto' or a registered model id. */
  requestedModelId?: string;
  allowFallback?: boolean;
  signal?: AbortSignal;
  requiredContextTokens?: number;
  requiredSize?: { width: number; height: number };
  /** Runs one attempt. Must throw on failure. */
  run: (model: ModelRow, ctx: { signal?: AbortSignal; timeoutMs: number }) => Promise<T>;
  /** Validates the payload before it is accepted. */
  validate: (value: T, model: ModelRow) => { ok: boolean; reason?: string; category?: AiErrorCategory };
  /** Extracts optional usage/cost metadata from the payload. */
  extract?: (value: T) => {
    usage?: { inputTokens?: number; outputTokens?: number };
    cost?: GenerationCost;
    provider?: string;
    imageWidth?: number;
    imageHeight?: number;
  };
  /** Persistence context (jobs, novels, users). */
  context?: {
    userId?: string | null;
    novelId?: string | null;
    chapterId?: string | null;
    jobId?: string | null;
    taskType?: string;
  };
  retryPolicy?: RetryPolicy;
}

/**
 * Runs a generation with automatic, task-compatible fallback.
 *
 * Throws an `HttpError` when nothing succeeded: the message is user-safe and
 * explains the real reason (never a raw provider error, never a credential).
 */
export async function orchestrateGeneration<T>(options: OrchestrateOptions<T>): Promise<OrchestratedResult<T>> {
  const policy = aiPolicy();
  const started = Date.now();
  const requestedModelId = options.requestedModelId && options.requestedModelId !== 'auto' ? options.requestedModelId : 'auto';

  const selection = selectModels({
    task: options.task,
    modelId: requestedModelId,
    allowFallback: options.allowFallback,
    requiredContextTokens: options.requiredContextTokens,
    requiredSize: options.requiredSize,
  });

  const trail: AttemptRecord[] = [];
  let attempts = 0;
  let lastError: AiErrorInfo | undefined;

  if (!selection.candidates.length) {
    const message = explainNoEligibleModel(selection);
    throw new HttpError(503, message, 'no_eligible_model', {
      requestedModelId,
      skipped: selection.skipped.slice(0, 12),
    });
  }

  for (const candidate of selection.candidates) {
    if (options.signal?.aborted) {
      throw new HttpError(499, 'The generation request was cancelled.', 'cancelled');
    }
    const model = candidate.model;
    if (!isCircuitClosed(model.id)) {
      trail.push({ modelId: model.id, category: 'provider_outage', latencyMs: 0, message: 'Circuit breaker open' });
      continue;
    }

    const modelStarted = Date.now();
    const outcome = await runWithRetries(
      async () => {
        attempts++;
        return await withDeadline(
          options.run(model, { signal: options.signal, timeoutMs: policy.requestTimeoutMs }),
          policy.requestTimeoutMs,
          `${options.task} request (${model.id})`,
        );
      },
      err => classifyAiError(err, { modelId: model.id, task: options.task }),
      {
        policy: options.retryPolicy ?? { maxAttempts: policy.maxRetriesPerModel + 1, baseDelayMs: 400, maxDelayMs: 4_000 },
        signal: options.signal,
      },
    );

    if (outcome.ok) {
      const validation = options.validate(outcome.value as T, model);
      if (!validation.ok) {
        const info = classifyAiError(new Error(validation.reason || 'The model returned unusable output.'), {
          modelId: model.id,
          task: options.task,
        });
        const category = validation.category ?? info.category;
        attempts++;
        trail.push({ modelId: model.id, category, latencyMs: Date.now() - modelStarted, message: validation.reason });
        recordModelFailure(model.id, { category, availability: info.availability, message: validation.reason, task: options.task });
        recordCircuitFailure(model.id, validation.reason);
        lastError = { ...info, category };
        continue;
      }

      const meta = options.extract?.(outcome.value as T);
      const latencyMs = Date.now() - modelStarted;
      const totalLatency = Date.now() - started;
      const fallbackUsed = requestedModelId !== 'auto' ? model.id !== requestedModelId : trail.length > 0;

      recordModelSuccess(model.id, { provider: meta?.provider, latencyMs, task: options.task });
      recordCircuitSuccess(model.id);
      trail.push({ modelId: model.id, provider: meta?.provider, category: 'success', latencyMs });

      const cost =
        meta?.cost ??
        costFor({
          model: model.id,
          inputTokens: meta?.usage?.inputTokens,
          outputTokens: meta?.usage?.outputTokens,
        });

      recordGenerationUsage({
        userId: options.context?.userId ?? null,
        novelId: options.context?.novelId ?? null,
        chapterId: options.context?.chapterId ?? null,
        jobId: options.context?.jobId ?? null,
        taskType: options.context?.taskType ?? options.task,
        task: options.task,
        requestedModel: requestedModelId,
        actualModel: model.id,
        provider: meta?.provider ?? model.provider ?? null,
        attempts,
        fallbackCount: fallbackUsed ? 1 : 0,
        latencyMs: totalLatency,
        inputTokens: meta?.usage?.inputTokens,
        outputTokens: meta?.usage?.outputTokens,
        imageWidth: meta?.imageWidth,
        imageHeight: meta?.imageHeight,
        cost,
        meta: { trail: trail.slice(-8) },
      });

      if (options.context?.jobId) {
        recordJobProvenance(options.context.jobId, {
          requestedModel: requestedModelId,
          actualModel: model.id,
          provider: meta?.provider ?? model.provider ?? null,
          fallbackCount: fallbackUsed ? 1 : 0,
          durationMs: totalLatency,
        });
      }

      return {
        ok: true,
        value: outcome.value as T,
        requestedModelId,
        actualModelId: model.id,
        provider: meta?.provider ?? model.provider ?? undefined,
        fallbackUsed,
        attempts,
        latencyMs: totalLatency,
        attemptTrail: trail,
        selection,
        usage: meta?.usage,
        cost,
      };
    }

    const info = outcome.error ?? classifyAiError(new Error('Unknown provider failure.'), { modelId: model.id });
    const latencyMs = Date.now() - modelStarted;
    trail.push({ modelId: model.id, category: info.category, latencyMs, message: info.userMessage });
    recordModelFailure(model.id, {
      category: info.category,
      availability: info.availability,
      message: info.userMessage,
      latencyMs,
      task: options.task,
    });
    recordCircuitFailure(model.id, info.userMessage);
    lastError = info;

    // A credentials problem applies to every model: stop immediately rather
    // than burning the whole fallback budget on the same 401.
    if (info.category === 'authentication_failed') break;
  }

  const message = buildFailureMessage(options.task, lastError, trail, selection);
  throw new HttpError(statusForError(lastError), message, lastError?.category ?? 'generation_failed', {
    requestedModelId,
    attempts: trail,
  });
}

function statusForError(info?: AiErrorInfo): number {
  if (!info) return 503;
  switch (info.category) {
    case 'authentication_failed':
    case 'permission_denied':
    case 'gated_model':
      return 403;
    case 'paid_inference_required':
    case 'quota_exceeded':
      return 402;
    case 'rate_limited':
      return 429;
    case 'invalid_request':
    case 'content_policy':
      return 400;
    case 'timeout':
      return 504;
    default:
      return 503;
  }
}

function buildFailureMessage(
  task: ModelTask,
  lastError: AiErrorInfo | undefined,
  trail: AttemptRecord[],
  selection: SelectionResult,
): string {
  const tried = trail.map(t => t.modelId).filter(Boolean);
  const detail = lastError?.userMessage ?? 'The provider did not return a usable result.';
  const reasons = new Set<string>(selection.skipped.slice(0, 6).map(s => s.reason));
  const skipDetail = reasons.size ? ` Skipped: ${Array.from(reasons).join('; ')}.` : '';
  return [
    `${task === 'text-to-image' ? 'Image' : 'Text'} generation failed: ${detail}`,
    tried.length ? `Tried ${tried.length} model(s): ${tried.slice(0, 5).join(', ')}.` : 'No model was attempted.',
    skipDetail,
    'Check model availability, access permissions and pricing settings in Admin → AI models.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Convenience wrapper: the typed text-generation result shape. */
export function toTextResult<T>(result: OrchestratedResult<T>, text: string): TextGenerationResult {
  return {
    text,
    requestedModelId: result.requestedModelId,
    actualModelId: result.actualModelId ?? result.requestedModelId,
    provider: result.provider,
    fallbackUsed: result.fallbackUsed,
    attempts: result.attempts,
    latencyMs: result.latencyMs,
    usage: result.usage,
    cost: result.cost,
    attempts_detail: result.attemptTrail.map(a => ({ modelId: a.modelId, provider: a.provider, category: a.category, latencyMs: a.latencyMs })),
  };
}

/** Convenience wrapper: the typed image-generation result shape. */
export function toImageResult(
  result: OrchestratedResult<{ buffer: Buffer; mimeType: string; width?: number; height?: number }>,
): ImageGenerationResult {
  const value = result.value!;
  return {
    image: value.buffer,
    mimeType: value.mimeType,
    requestedModelId: result.requestedModelId,
    actualModelId: result.actualModelId ?? result.requestedModelId,
    provider: result.provider,
    fallbackUsed: result.fallbackUsed,
    attempts: result.attempts,
    latencyMs: result.latencyMs,
    width: value.width,
    height: value.height,
    cost: result.cost,
    attempts_detail: result.attemptTrail.map(a => ({ modelId: a.modelId, provider: a.provider, category: a.category, latencyMs: a.latencyMs })),
  };
}

/** True when hosted generation is usable at all right now. */
export function hostedGenerationAvailable(): { available: boolean; reason?: string } {
  const policy = aiPolicy();
  if (policy.backend !== 'huggingface' && policy.backend !== 'agnes') {
    return {
      available: false,
      reason: 'No hosted backend is active (set AGNES_API_KEY for Agnes AI, or HF_TOKEN for Hugging Face).',
    };
  }
  return { available: true };
}
