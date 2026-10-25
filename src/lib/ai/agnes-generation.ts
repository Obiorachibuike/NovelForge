/**
 * Agnes AI generation, wired into NovelForge's existing text and image
 * services.
 *
 * Agnes AI is the primary provider for both modalities:
 *  - text:  `agnes-2.5-flash` through the OpenAI-compatible chat completions
 *           endpoint (plain and Zod-validated structured output);
 *  - image: `agnes-image-2.5-flash` through `/v1/images/generations`.
 *
 * These functions throw on failure — the provenance decision (fall back to
 * Hugging Face, or surface a labelled fallback to the caller) belongs to the
 * entry points in `text-generation.ts` and `image-generation.ts`, exactly as it
 * does for the OpenAI and Hugging Face paths.
 */
import 'server-only';
import { z, type ZodType, type ZodTypeDef } from 'zod';
import { aiPolicy } from './config';
import {
  agnesChatCompletion,
  agnesGenerateImage,
  AgnesHttpError,
} from './agnes-client';

export { AgnesHttpError };
import { extractJsonObject, validateImageBuffer, validateTextOutput } from './output-validation';
import { assertAiBudget, clampCompletionTokens, estimateCostUsd, estimateImageCostUsd, recordUsage } from './provider';

export type AgnesGenerationCost = { amount?: number; currency?: string; status: 'confirmed' | 'estimated' | 'unknown' };

export interface AgnesTextInput {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  userId: string;
  novelId?: string;
  chapterId?: string;
  jobId?: string;
  taskType: string;
  signal?: AbortSignal;
  /** Total provider attempts before giving up (default 2, retryable errors only). */
  retries?: number;
}

export interface AgnesTextResult {
  text: string;
  model: string;
  requestedModel: string;
  provider: string;
  attempts: number;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  cost?: AgnesGenerationCost;
}

export interface AgnesImageInput {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  sizeTier?: '1K' | '2K' | '3K' | '4K';
  model?: string;
  userId?: string;
  novelId?: string;
  jobId?: string;
  taskType?: string;
  signal?: AbortSignal;
}

export interface AgnesImageOutput {
  buffer: Buffer;
  mimeType: string;
  model: string;
  provider: string;
  width?: number;
  height?: number;
  attempts: number;
  latencyMs: number;
  cost?: AgnesGenerationCost;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isRetryableAgnesError(err: unknown): boolean {
  if (err instanceof AgnesHttpError) {
    if ([400, 401, 403, 404, 422].includes(err.status)) return false;
    return err.status === 429 || err.status >= 500;
  }
  const anyErr = err as { name?: string; status?: number };
  if (anyErr?.name === 'AbortError') return false;
  if (typeof anyErr?.status === 'number') return anyErr.status === 429 || anyErr.status >= 500;
  const msg = errorMessage(err);
  if (/timed out|rate limit|429|502|503|504|econnreset|socket hang up|temporarily unavailable/i.test(msg)) return true;
  return false;
}

async function sleepWithJitter(attempt: number, baseMs = 300): Promise<void> {
  const exp = Math.min(4_000, baseMs * 2 ** attempt);
  const jitter = Math.floor(Math.random() * Math.max(50, Math.round(exp * 0.25)));
  const ms = exp + jitter;
  if (_sleepForTests) return _sleepForTests(ms);
  await new Promise(resolve => setTimeout(resolve, ms));
}

let _sleepForTests: ((ms: number) => Promise<void>) | null = null;
/** Test seam: replaces the retry backoff sleep so tests stay deterministic. */
export function __setAgnesSleepForTests(fn: ((ms: number) => Promise<void>) | null) {
  _sleepForTests = fn;
}

/** Plain-text generation through Agnes AI with bounded, retryable attempts. */
export async function generateTextAgnes(input: AgnesTextInput): Promise<AgnesTextResult> {
  const policy = aiPolicy();
  const model = input.model || policy.agnesTextModel;
  const maxTokens = clampCompletionTokens(input.maxTokens);
  const estPrompt = Math.ceil(input.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) / 4);
  assertAiBudget(input.userId, estPrompt + maxTokens);
  const estimatedCostBeforeUsd = estimateCostUsd(model, estPrompt, Math.round(maxTokens * 0.6));

  const attempts = Math.max(1, Math.min(input.retries ?? 2, 4));
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (input.signal?.aborted) throw new Error('Generation request was cancelled.');
      const completion = await agnesChatCompletion({
        messages: input.messages,
        model,
        temperature: input.temperature ?? 0.8,
        maxNewTokens: maxTokens,
        ...(typeof input.topP === 'number' ? { topP: input.topP } : {}),
        signal: input.signal,
      });
      const check = validateTextOutput(completion.text, { minChars: 1 });
      if (!check.ok) throw Object.assign(new Error(check.reason || 'The model returned no text.'), { status: 502 });

      recordUsage({
        userId: input.userId,
        novelId: input.novelId,
        chapterId: input.chapterId,
        jobId: input.jobId,
        taskType: input.taskType,
        model: completion.model,
        provider: 'agnes-ai',
        promptTokens: completion.usage?.inputTokens ?? estPrompt,
        completionTokens: completion.usage?.outputTokens ?? Math.ceil(completion.text.length / 4),
        estimatedCostBeforeUsd,
        source: 'agnes',
      });

      return {
        text: completion.text,
        model: completion.model,
        requestedModel: model,
        provider: 'agnes-ai',
        attempts: attempt + 1,
        latencyMs: completion.latencyMs,
        usage: completion.usage,
        cost: { status: 'estimated' },
      };
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < attempts && isRetryableAgnesError(err)) {
        await sleepWithJitter(attempt);
        continue;
      }
      break;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(errorMessage(lastErr));
}

export interface AgnesStructuredInput<T> extends Omit<AgnesTextInput, 'maxTokens'> {
  schema: ZodType<T, ZodTypeDef, unknown>;
  maxTokens?: number;
}

/**
 * Structured (JSON) generation through Agnes AI.
 *
 * Asks for a JSON object through `response_format`; if the service rejects the
 * parameter the same request is retried as plain text and the JSON is
 * extracted. The parsed value must satisfy the caller's Zod schema — a
 * malformed response is a thrown failure, never invented data.
 */
export async function generateStructuredAgnes<T>(input: AgnesStructuredInput<T>): Promise<{ data: T; meta: AgnesTextResult }> {
  const policy = aiPolicy();
  const model = input.model || policy.agnesTextModel;
  const maxTokens = clampCompletionTokens(input.maxTokens ?? 4_096);
  const estPrompt = Math.ceil(input.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) / 4);
  assertAiBudget(input.userId, estPrompt + 2_000);
  const estimatedCostBeforeUsd = estimateCostUsd(model, estPrompt, 1_500);
  const jsonInstruction =
    'Respond with a single valid JSON object and nothing else. No prose, no markdown, no code fences.';

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = input.messages.map(m => ({
    role: m.role,
    content: m.role === 'system' ? `${m.content}\n\n${jsonInstruction}` : m.content,
  }));
  if (!messages.some(m => m.role === 'system')) {
    messages.unshift({ role: 'system', content: jsonInstruction });
  }

  const attempts = Math.max(1, Math.min(input.retries ?? 2, 4));
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (input.signal?.aborted) throw new Error('Generation request was cancelled.');
      let raw = '';
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      try {
        const completion = await agnesChatCompletion({
          messages,
          model,
          temperature: input.temperature ?? 0.4,
          maxNewTokens: maxTokens,
          responseFormat: 'json_object',
          signal: input.signal,
        });
        raw = completion.text;
        usage = completion.usage;
      } catch (err) {
        const status = err instanceof AgnesHttpError ? err.status : (err as { status?: number })?.status;
        if (status !== 400 && status !== 422 && status !== 404) throw err;
        // Structured output not supported for this model: retry as plain text.
        const completion = await agnesChatCompletion({
          messages,
          model,
          temperature: input.temperature ?? 0.4,
          maxNewTokens: maxTokens,
          signal: input.signal,
        });
        raw = completion.text;
        usage = completion.usage;
      }

      const candidate = extractJsonObject(raw);
      if (!candidate) {
        throw Object.assign(new Error('The model did not return a JSON object.'), { status: 502 });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        throw Object.assign(new Error('The model returned invalid JSON.'), { status: 502 });
      }
      const validated = input.schema.safeParse(parsed);
      if (!validated.success) {
        const first = validated.error.errors[0];
        throw Object.assign(
          new Error(`Schema validation failed: ${first ? `${first.path.join('.') || 'root'}: ${first.message}` : 'unknown'}`),
          { status: 502 },
        );
      }

      recordUsage({
        userId: input.userId,
        novelId: input.novelId,
        chapterId: input.chapterId,
        jobId: input.jobId,
        taskType: input.taskType,
        model,
        provider: 'agnes-ai',
        promptTokens: usage?.inputTokens ?? estPrompt,
        completionTokens: usage?.outputTokens ?? Math.ceil(raw.length / 4),
        estimatedCostBeforeUsd,
        source: 'agnes',
      });

      return {
        data: validated.data,
        meta: {
          text: raw,
          model,
          requestedModel: model,
          provider: 'agnes-ai',
          attempts: attempt + 1,
          latencyMs: 0,
          usage,
          cost: { status: 'estimated' },
        },
      };
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < attempts && isRetryableAgnesError(err)) {
        await sleepWithJitter(attempt);
        continue;
      }
      break;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(errorMessage(lastErr));
}

/**
 * Generates one validated image through Agnes AI.
 *
 * The buffer is magic-number-validated before it is returned, so a JSON error
 * body served with HTTP 200 can never be stored as a cover.
 */
export async function generateImageAgnes(input: AgnesImageInput): Promise<AgnesImageOutput> {
  const policy = aiPolicy();
  const prompt = input.negativePrompt
    ? `${input.prompt}\n\nAvoid: ${input.negativePrompt}`
    : input.prompt;

  const generated = await agnesGenerateImage({
    prompt,
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
    ...(input.sizeTier ? { sizeTier: input.sizeTier } : {}),
    ...(input.model ? { model: input.model } : {}),
    signal: input.signal,
  });

  const check = validateImageBuffer(generated.buffer, { minBytes: 1_000 });
  if (!check.ok) {
    const err = new Error(check.reason || 'Agnes AI returned an invalid image.');
    (err as { status?: number }).status = 502;
    throw err;
  }

  if (input.userId) {
    recordUsage({
      userId: input.userId,
      novelId: input.novelId,
      jobId: input.jobId,
      taskType: input.taskType ?? 'cover',
      model: generated.model,
      provider: 'agnes-ai',
      promptTokens: 0,
      completionTokens: 0,
      source: 'agnes',
      meta: { images: 1, width: generated.width, height: generated.height },
    });
  }

  return {
    buffer: generated.buffer,
    mimeType: generated.mimeType,
    model: generated.model,
    provider: 'agnes-ai',
    width: generated.width ?? policy.maxImageEdge,
    height: generated.height,
    attempts: 1,
    latencyMs: generated.latencyMs,
    cost: {
      amount: estimateImageCostUsd(generated.model, 1),
      currency: 'USD',
      status: 'estimated',
    },
  };
}
