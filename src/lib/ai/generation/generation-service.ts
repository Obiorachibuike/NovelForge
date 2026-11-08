import 'server-only';
import type {
  GenerationExecutionContext,
  GenerationRequest,
  GenerationResult,
} from './generation-types';
import { GenerationRegistry } from './generation-registry';
import { cancelJob, finalizeJob, persistChunk } from './generation-persistence';
import { validateGenerationRequest } from './generation-validation';
import { enqueue, type EnqueueOptions } from '@/lib/queue';
import {
  agnesBackendActive,
  generateTextDetailed,
  huggingFaceBackendActive,
  type GenerationMeta,
} from '@/lib/ai/text-generation';
import { generateTextAgnes } from '@/lib/ai/agnes-generation';
import { generateTextHuggingFace } from '@/lib/ai/hf-text-generation';
import { aiConfig } from '@/lib/ai/provider';
import type { ChatMessage } from '@/types';

/**
 * UniversalGenerationService
 *
 * Central engine that handles:
 * 1. Job creation — through the one durable queue (`enqueue`), so a universal
 *    job is a normal `generation_jobs` row that is dispatched, retried,
 *    cancelled and recovered like every other job;
 * 2. Provider selection & capability detection;
 * 3. Real-time incremental streaming (where supported);
 * 4. Chunk persistence & event publishing;
 * 5. Cancellation.
 *
 * Execution always receives the durable job id and payload through
 * `GenerationExecutionContext`; nothing here derives job state from the novel id.
 */

/** Generation types the built-in engine can serve without a registered handler. */
const BUILT_IN_TEXT_TYPES = new Set<string>([
  'chapter',
  'chapter_outline',
  'story_outline',
  'novel_summary',
  'novel_description',
  'novel_title',
  'story_idea',
  'character',
  'character_backstory',
  'worldbuilding',
  'location',
  'culture',
  'history',
  'rewrite',
  'expand',
  'summarize',
  'shorten',
  'proofread',
  'humanize',
  'premise',
  'outline',
]);

type ResultMeta = GenerationResult['meta'];

/**
 * Provider adapters report `attempts`/`latencyMs` as optional; a persisted
 * result always states them so the UI and cost reporting never guess.
 */
function toResultMeta(meta: GenerationMeta): ResultMeta {
  return {
    source: meta.source,
    model: meta.model,
    ...(meta.actualModel ? { actualModel: meta.actualModel } : {}),
    ...(meta.provider ? { provider: meta.provider } : {}),
    usedFallback: Boolean(meta.usedFallback),
    ...(meta.fallbackReason ? { fallbackReason: meta.fallbackReason } : {}),
    attempts: meta.attempts ?? 1,
    latencyMs: meta.latencyMs ?? 0,
  };
}

/** Maps a validated universal request onto the durable queue's task shape. */
function toEnqueueOptions(request: GenerationRequest): EnqueueOptions {
  const payload: Record<string, unknown> = {
    prompt: request.prompt,
    generationType: request.generationType,
  };
  if (request.targetType) payload.targetType = request.targetType;
  if (request.targetId) payload.targetId = request.targetId;
  if (request.provider) payload.provider = request.provider;
  if (request.model) payload.model = request.model;
  if (request.stream) payload.stream = true;
  if (request.metadata) payload.metadata = request.metadata;
  if (request.context) payload.context = request.context;

  // `generation_jobs.chapterId` is the chapter column (it drives the sequential
  // gate and the API's chapter join), so only a chapter target may fill it.
  const isChapterTarget =
    request.generationType === 'chapter' || request.targetType === 'chapter';

  return {
    type: request.generationType,
    novelId: request.projectId,
    userId: request.userId,
    chapterId: isChapterTarget ? request.targetId ?? null : null,
    payload,
    ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
  };
}

export class UniversalGenerationService {
  /**
   * Creates a durable generation job and returns its ID.
   *
   * The job row is inserted by the queue (idempotency, priority, lifecycle
   * events with real ownership) and dispatched to pg-boss or the worker sweep,
   * which calls `executeJob` when it claims the row.
   */
  static async createJob(request: GenerationRequest): Promise<string> {
    const validated = validateGenerationRequest(request);
    return enqueue(toEnqueueOptions(validated));
  }

  /**
   * Worker handler: executes the generation described by a claimed job row.
   *
   * Registered handlers win (they own their domain's persistence); everything
   * else falls back to the built-in text engine.
   */
  static async executeJob(
    request: GenerationRequest,
    context: GenerationExecutionContext,
  ): Promise<unknown> {
    const handler = GenerationRegistry.getHandler(request.generationType);
    if (handler) {
      return await handler(request, context);
    }

    if (BUILT_IN_TEXT_TYPES.has(request.generationType)) {
      return await this.handleTextGeneration(request, context);
    }

    if (request.generationType === 'image') {
      // Covers own storage, per-novel limits and honest fallback labelling in
      // `generateCovers` (src/services/images/service.ts). The universal engine
      // has no asset pipeline, so generating here would burn a paid image call
      // and throw the bytes away.
      throw new Error(
        'Image generation runs through the cover service, not the universal generation engine.',
      );
    }

    throw new Error(`No handler registered for generation type: ${request.generationType}`);
  }

  /**
   * Core text generation with streaming support.
   */
  private static async handleTextGeneration(
    request: GenerationRequest,
    context: GenerationExecutionContext,
  ): Promise<GenerationResult> {
    const { prompt, userId, projectId, targetId, generationType, provider, model, stream } = request;

    // Construct messages (simplified for universal engine — registered handlers
    // build their own domain prompts).
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are generating content for ${generationType}. Follow the context provided.`,
      },
      { role: 'user', content: prompt },
    ];

    // Capability detection
    const isStreamingSupported = Boolean(stream) && (agnesBackendActive() || huggingFaceBackendActive());

    const shared = {
      messages,
      userId,
      novelId: projectId,
      chapterId: targetId,
      jobId: context.jobId,
      taskType: generationType,
      signal: context.signal,
    };

    let result: GenerationResult;

    if (isStreamingSupported) {
      // Real provider streaming. Chunks are persisted against the job row,
      // which also acts as the worker heartbeat for a long generation.
      context.setStage('GENERATING_CONTENT');
      let accumulatedText = '';
      let sequence = 0;
      const onText = (chunk: string) => {
        if (context.isCancelled()) throw new Error('Generation was cancelled.');
        sequence += 1;
        accumulatedText += chunk;
        persistChunk(context.jobId, sequence, chunk);
      };

      if (agnesBackendActive() && !provider?.includes('huggingface')) {
        const completion = await generateTextAgnes({
          ...shared,
          onText,
          model: model || aiConfig.textModel,
          maxTokens: 4096,
        });
        result = {
          text: accumulatedText || completion.text,
          meta: {
            source: 'agnes',
            model: completion.model,
            actualModel: completion.model,
            provider: completion.provider || 'agnes-ai',
            usedFallback: false,
            attempts: completion.attempts,
            latencyMs: completion.latencyMs,
            usage: completion.usage,
            cost: completion.cost,
          },
        };
      } else if (huggingFaceBackendActive()) {
        const completion = await generateTextHuggingFace({
          ...shared,
          onText,
          model: model || 'auto',
          allowFallback: true,
        });
        result = {
          text: accumulatedText || completion.text,
          meta: {
            source: 'huggingface',
            model: completion.model,
            actualModel: completion.model,
            provider: completion.provider,
            usedFallback: completion.fallbackUsed,
            attempts: completion.attempts,
            latencyMs: completion.latencyMs,
            usage: completion.usage,
            cost: completion.cost,
          },
        };
      } else {
        const completion = await generateTextDetailed({
          ...shared,
          onText,
          model: model || aiConfig.textModel,
          allowFallbackOnError: false,
        });
        result = {
          text: accumulatedText || completion.text,
          meta: toResultMeta(completion.meta),
        };
      }
    } else {
      // Non-streaming: no provider supports streaming for this request, so the
      // caller gets one final result and the job row is finalized once.
      context.setStage('PROCESSING');
      const completion = await generateTextDetailed({
        ...shared,
        model,
        allowFallbackOnError: false,
      });
      result = { text: completion.text, meta: toResultMeta(completion.meta) };
    }

    finalizeJob(context.jobId, 'completed', result);
    return result;
  }

  /**
   * Cancellation. The queue's `cancelJob` owns the durable path (status guard,
   * chapter status, notifications); this is the engine-level entry point.
   */
  static cancel(jobId: string, reason?: string) {
    return cancelJob(jobId, reason);
  }
}
