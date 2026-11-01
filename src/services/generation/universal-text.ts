import 'server-only';

import { generateTextDetailed } from '@/lib/ai/text-generation';
import { registerHandler, type JobHandlerContext } from '@/lib/queue';

/**
 * Shared worker handler for ad-hoc AI text generation. Feature-specific
 * services can enqueue this task with a generationType and target metadata;
 * the durable queue, streaming events, cancellation and recovery are shared.
 */
export interface UniversalTextPayload {
  generationType: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  allowModelFallback?: boolean;
  targetType?: string;
  targetId?: string;
  title?: string;
}

export async function runUniversalTextGeneration(job: JobHandlerContext) {
  const payload = job.payload as unknown as UniversalTextPayload;
  if (!payload || typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
    throw Object.assign(new Error('A generation prompt is required.'), { retryable: false, code: 'invalid_generation_prompt' });
  }
  if (job.isCancelled()) throw Object.assign(new Error('Generation was cancelled.'), { retryable: false, code: 'cancelled' });

  let accumulated = '';
  let lastPublishedText = '';
  let lastPublishedAt = 0;
  const result = await generateTextDetailed({
    messages: [
      ...(payload.systemPrompt ? [{ role: 'system' as const, content: payload.systemPrompt }] : []),
      { role: 'user' as const, content: payload.prompt },
    ],
    ...(payload.model ? { model: payload.model } : {}),
    maxTokens: payload.maxTokens ?? 2048,
    temperature: payload.temperature ?? 0.8,
    userId: job.userId,
    novelId: job.novelId,
    jobId: job.id,
    taskType: payload.generationType,
    signal: job.signal,
    allowFallbackOnError: false,
    allowModelFallback: payload.allowModelFallback !== false,
    onText: (snapshot: string) => {
      if (job.signal.aborted || !snapshot) return;
      let chunk = '';
      if (snapshot.startsWith(accumulated)) {
        chunk = snapshot.slice(accumulated.length);
      } else {
        // A provider fallback can start a fresh response after an upstream
        // failure. Replace the visible partial rather than duplicating text.
        accumulated = '';
        chunk = snapshot;
      }
      if (!chunk) return;
      accumulated = snapshot;
      // Batch rapid provider deltas into modest durable chunks. The final
      // flush below guarantees that no text is lost between batches.
      if (Date.now() - lastPublishedAt >= 150) {
        job.onContent(chunk, accumulated);
        lastPublishedText = accumulated;
        lastPublishedAt = Date.now();
      }
    },
  });

  if (job.signal.aborted || job.isCancelled()) {
    throw Object.assign(new Error('Generation was cancelled.'), { retryable: false, code: 'cancelled' });
  }
  if (!result.text.trim()) throw new Error('The AI provider returned an empty response.');
  if (result.text !== lastPublishedText) {
    const finalChunk = result.text.startsWith(lastPublishedText)
      ? result.text.slice(lastPublishedText.length)
      : result.text;
    if (finalChunk) job.onContent(finalChunk, result.text);
  }

  // Keep partialText in the final result so the existing generation serializer
  // can restore the content after refresh, even after the job is complete.
  return {
    partialText: result.text,
    text: result.text,
    generationType: payload.generationType,
    targetType: payload.targetType ?? null,
    targetId: payload.targetId ?? null,
    title: payload.title ?? null,
    provider: result.meta.provider ?? result.meta.source,
    model: result.meta.actualModel ?? result.meta.model,
    usedFallback: result.meta.usedFallback,
  };
}

registerHandler('ai-content', runUniversalTextGeneration);
