/**
 * Hugging Face text generation, wired into NovelForge's existing text service.
 *
 * These functions are what `src/lib/ai/text-generation.ts` delegates to when
 * the Hugging Face backend is active. They return the same `TextResult` /
 * `StructuredResult` shapes as the OpenAI path, so no caller changes: outlines,
 * chapters, premises, consistency checks and editor actions all keep working
 * and simply gain a task-compatible fallback chain.
 */
import 'server-only';
import { z, type ZodType, type ZodTypeDef } from 'zod';
import { aiPolicy } from './config';
import { orchestrateGeneration } from './fallback-orchestrator';
import { hfChatCompletion, type HfChatCompletionResult } from './huggingface-client';
import { deduplicateParagraphs, extractJsonObject, validateTextOutput } from './output-validation';

export interface HfTextInput {
  onText?: (text: string) => void;
  /** Chat messages (system + user) in NovelForge's existing format. */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  userId?: string;
  novelId?: string;
  chapterId?: string;
  jobId?: string;
  taskType: string;
  signal?: AbortSignal;
  allowFallback?: boolean;
  /** Drop repeated paragraphs models emit when given long context. */
  deduplicate?: boolean;
}

export interface HfTextResult {
  text: string;
  model: string;
  requestedModel: string;
  provider?: string;
  fallbackUsed: boolean;
  attempts: number;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  cost?: { amount?: number; currency?: string; status: 'confirmed' | 'estimated' | 'unknown' };
  trail: Array<{ modelId: string; provider?: string; category: string; latencyMs: number; message?: string }>;
}

function splitMessages(messages: HfTextInput['messages']): { systemPrompt?: string; prompt: string } {
  const system = messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
    .join('\n\n');
  const rest = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n\n');
  return { systemPrompt: system || undefined, prompt: rest };
}

/** Estimates prompt size so tiny-context models can be filtered out. */
export function estimatePromptTokens(messages: Array<{ content?: string }>): number {
  const chars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  return Math.ceil(chars / 4);
}

/** Plain-text generation with automatic, task-compatible fallback. */
export async function generateTextHuggingFace(input: HfTextInput): Promise<HfTextResult> {
  const policy = aiPolicy();
  const { systemPrompt, prompt } = splitMessages(input.messages);
  const requiredContextTokens = estimatePromptTokens(input.messages) + (input.maxTokens ?? 2_048) + 512;

  const result = await orchestrateGeneration<HfChatCompletionResult>({
    task: 'text-generation',
    requestedModelId: input.model && input.model !== 'auto' ? input.model : 'auto',
    allowFallback: input.allowFallback,
    signal: input.signal,

    requiredContextTokens,
    context: {
      userId: input.userId ?? null,
      novelId: input.novelId ?? null,
      chapterId: input.chapterId ?? null,
      jobId: input.jobId ?? null,
      taskType: input.taskType,
    },
    run: model => hfChatCompletion({
      modelId: model.id,
      systemPrompt,
      prompt,
      maxNewTokens: input.maxTokens ?? 2_048,
      temperature: input.temperature ?? 0.8,
      signal: input.signal,
      onText: input.onText,
    }),
    validate: value => {
      const check = validateTextOutput(value.text, { minChars: 1, rejectPromptEcho: true, prompt });
      return { ok: check.ok, reason: check.reason, category: check.category };
    },
    extract: value => ({ provider: value.provider, usage: value.usage }),
  });

  const raw = result.value?.text ?? '';
  const text = input.deduplicate ? deduplicateParagraphs(raw) : raw;
  return {
    text,
    model: result.actualModelId ?? result.requestedModelId,
    requestedModel: result.requestedModelId,
    provider: result.provider,
    fallbackUsed: result.fallbackUsed,
    attempts: result.attempts,
    latencyMs: result.latencyMs,
    usage: result.usage,
    cost: result.cost,
    trail: result.attemptTrail,
  };
}

export interface HfStructuredInput<T> extends HfTextInput {
  schema: ZodType<T, ZodTypeDef, unknown>;
  /** Used only when every model fails and the caller allows a fallback value. */
  fallback?: T;
}

/**
 * Structured (JSON) generation.
 *
 * Asks for a JSON object where the provider supports it; if the provider
 * rejects the parameter, the same request is retried as plain text and the JSON
 * is extracted. Output is validated with the caller's Zod schema; a malformed
 * response is a normal failure, so the orchestrator moves to the next model
 * rather than saving invented data.
 */
export async function generateStructuredHuggingFace<T>(input: HfStructuredInput<T>): Promise<{ data: T; meta: HfTextResult }> {
  const { systemPrompt, prompt } = splitMessages(input.messages);
  const jsonInstruction =
    'Respond with a single valid JSON object and nothing else. No prose, no markdown, no code fences.';
  const requiredContextTokens = estimatePromptTokens(input.messages) + 2_048 + 512;

  const result = await orchestrateGeneration<{
    data: T;
    raw: string;
    provider?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  }>({
    task: 'text-generation',
    requestedModelId: input.model && input.model !== 'auto' ? input.model : 'auto',
    allowFallback: input.allowFallback,
    signal: input.signal,
    requiredContextTokens,
    context: {
      userId: input.userId ?? null,
      novelId: input.novelId ?? null,
      chapterId: input.chapterId ?? null,
      jobId: input.jobId ?? null,
      taskType: input.taskType,
    },
    run: async model => {
      let raw = '';
      let provider: string | undefined;
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      try {
        const completion = await hfChatCompletion({
          modelId: model.id,
          systemPrompt: `${systemPrompt ? `${systemPrompt}\n\n` : ''}${jsonInstruction}`,
          prompt,
          maxNewTokens: input.maxTokens ?? 4_096,
          temperature: input.temperature ?? 0.4,
          responseFormat: 'json_object',
          signal: input.signal,
        });
        raw = completion.text;
        provider = completion.provider;
        usage = completion.usage;
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status !== 400 && status !== 422 && status !== 404) throw err;
        // Provider does not support structured output: retry as plain text.
        const completion = await hfChatCompletion({
          modelId: model.id,
          systemPrompt: `${systemPrompt ? `${systemPrompt}\n\n` : ''}${jsonInstruction}`,
          prompt,
          maxNewTokens: input.maxTokens ?? 4_096,
          temperature: input.temperature ?? 0.4,
          signal: input.signal,
        });
        raw = completion.text;
        provider = completion.provider;
        usage = completion.usage;
      }
      const candidate = extractJsonObject(raw);
      if (!candidate) {
        const err = new Error('The model did not return a JSON object.');
        (err as any).status = 502;
        throw err;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        const err = new Error('The model returned invalid JSON.');
        (err as any).status = 502;
        throw err;
      }
      return { data: parsed as T, raw, provider, usage };
    },
    validate: value => {
      const parsed = input.schema.safeParse(value.data);
      if (parsed.success) return { ok: true };
      const first = parsed.error.errors[0];
      return {
        ok: false,
        category: 'malformed_output' as const,
        reason: `Schema validation failed: ${first ? `${first.path.join('.') || 'root'}: ${first.message}` : 'unknown'}`,
      };
    },
    extract: value => ({ provider: value.provider, usage: value.usage }),
  });

  return {
    data: result.value.data,
    meta: {
      text: result.value.raw,
      model: result.actualModelId ?? result.requestedModelId,
      requestedModel: result.requestedModelId,
      provider: result.provider,
      fallbackUsed: result.fallbackUsed,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
      usage: result.usage,
      cost: result.cost,
      trail: result.attemptTrail,
    },
  };
}

export { z };
