import { z, type ZodType, type ZodTypeDef } from 'zod';
import {
  getOpenAI, aiConfig, withTimeout, recordUsage, assertAiBudget, clampCompletionTokens, estimateCostUsd,
} from './provider';
import type { ChatMessage } from '@/types';
import 'server-only';

/**
 * Where a piece of generated output actually came from.
 *
 * - `openai`   — a real provider response.
 * - `demo`     — deliberate demo mode (no API key, or AI_DEMO_MODE=true).
 * - `fallback` — a real request was attempted and the stub was substituted
 *                because the provider failed or the structured output could not
 *                be parsed. `fallbackReason` explains why, and callers are
 *                expected to surface/log it rather than treat the output as
 *                real. Chapter generation refuses this substitution entirely.
 */
export type GenerationSource = 'openai' | 'demo' | 'fallback';

export interface GenerationMeta {
  source: GenerationSource;
  model: string;
  usedFallback: boolean;
  fallbackReason?: string;
}

export interface TextResult { text: string; meta: GenerationMeta }
export interface StructuredResult<T> { data: T; meta: GenerationMeta }

export interface GenerateTextInput {
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
  /** When true (default) a provider failure rethrows so the caller decides. */
  allowFallbackOnError?: boolean;
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

/** Chat completion that returns plain text plus provenance. */
export async function generateTextDetailed(input: GenerateTextInput): Promise<TextResult> {
  const client = getOpenAI();
  const model = input.model || aiConfig.textModel;
  if (!client) {
    return {
      text: input.fallbackText ?? demoTextResponse(input.messages),
      meta: { source: 'demo', model, usedFallback: false },
    };
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
      const resp = await withTimeout(
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
      recordUsage({
        userId: input.userId,
        novelId: input.novelId,
        chapterId: input.chapterId,
        jobId: input.jobId,
        taskType: input.taskType,
        model,
        promptTokens: usage?.prompt_tokens ?? estPrompt,
        completionTokens: usage?.completion_tokens ?? estimateCompletionTokens(text),
        estimatedCostBeforeUsd,
        source: 'openai',
      });
      return { text, meta: { source: 'openai', model, usedFallback: false } };
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < maxAttempts && isRetryableProviderError(err)) {
        await sleepWithJitter(attempt);
        continue;
      }
      break;
    }
  }

  const reason = errorMessage(lastErr);
  if (!input.allowFallbackOnError) throw lastErr;
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
  const client = getOpenAI();
  const model = input.model || aiConfig.structuredModel;
  if (!client) {
    return { data: input.fallback, meta: { source: 'demo', model, usedFallback: false } };
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
      const usage = resp.usage;
      recordUsage({
        userId: input.userId,
        novelId: input.novelId,
        chapterId: input.chapterId,
        jobId: input.jobId,
        taskType: input.taskType,
        model,
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
      if (result.success) return { data: result.data, meta: { source: 'openai', model, usedFallback: false } };
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
