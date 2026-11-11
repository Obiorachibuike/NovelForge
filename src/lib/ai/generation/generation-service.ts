import 'server-only';
import { z } from 'zod';
import {
  GENERATION_TYPE_INSTRUCTIONS,
  GENERATION_TYPE_LABELS,
  isGenerationProvider,
  type GenerationExecutionContext,
  type GenerationProvider,
  type GenerationRequest,
  type GenerationRequestInput,
  type GenerationResult,
} from './generation-types';
import { GenerationRegistry } from './generation-registry';
import {
  isUniversalEngineJob,
  openChunkSink,
  parseJobPayload,
  recordGenerationProvenance,
  UNIVERSAL_ENGINE,
  type ChunkSink,
} from './generation-persistence';
import { validateGenerationRequest } from './generation-validation';
import { agnesConfigured, huggingFaceConfigured } from '@/lib/ai/config';
import { aiConfig } from '@/lib/ai/provider';
import { generateImage } from '@/lib/ai/image-generation';
import { generateStructuredDetailed, generateTextDetailed } from '@/lib/ai/text-generation';
import { saveFile } from '@/lib/storage';
import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import type { ChatMessage } from '@/types';

/**
 * UniversalGenerationService
 *
 * The single generation *engine* shared by every AI feature:
 *
 *  1. `createJob()` validates a request and hands it to the durable queue
 *     (one row in `generation_jobs` + a pg-boss wake-up);
 *  2. the dedicated worker claims the row and calls `executeJob()`;
 *  3. `executeJob()` routes to a registered handler or to the built-in text,
 *     structured or image path, persists every chunk with a monotonic sequence
 *     number, publishes replayable events, reports stages/progress and honours
 *     cancellation;
 *  4. the **worker** finalises the job (see `generation-persistence.ts`). This
 *     service never writes a terminal status, so there is exactly one
 *     finalisation owner.
 */

/** A request is only ever executed when its provider chain is explicit. */
export function resolveProviderChain(
  request: Pick<GenerationRequest, 'provider' | 'metadata'>,
  env: { agnes: boolean; huggingface: boolean; openai: boolean } = {
    // AI_DEMO_MODE=true performs no paid calls anywhere, even with keys set.
    agnes: agnesConfigured() && !aiConfig.forcedDemo,
    huggingface: huggingFaceConfigured() && !aiConfig.forcedDemo,
    openai: aiConfig.hasApiKey && !aiConfig.forcedDemo,
  },
): GenerationProvider[] {
  const requested = isGenerationProvider(request.provider) ? request.provider : undefined;
  const allowFallback = request.metadata?.allowFallback !== false;

  // Priority: Agnes AI (primary) → Hugging Face (fallback) → OpenAI.
  const priority: GenerationProvider[] = ['agnes', 'huggingface', 'openai'];
  const available: Record<GenerationProvider, boolean> = env;

  if (requested) {
    const chain: GenerationProvider[] = [requested];
    if (allowFallback) {
      for (const provider of priority) {
        if (provider !== requested) chain.push(provider);
      }
    }
    // Keep only providers that can actually serve a request. The requested one
    // stays in the chain even when unconfigured so the failure is explicit.
    return chain.filter(provider => provider === requested || available[provider]);
  }

  const chain = priority.filter(provider => available[provider]);
  return chain;
}

function allowFallback(request: GenerationRequest): boolean {
  return request.metadata?.allowFallback !== false;
}

function allowStubOutput(): boolean {
  // Demo/stub prose is never presented as real generation in production.
  if (aiConfig.forcedDemo) return true;
  return process.env.NODE_ENV !== 'production';
}

function buildMessages(request: GenerationRequest): ChatMessage[] {
  const label = request.customType
    ? `custom task "${request.customType}"`
    : GENERATION_TYPE_LABELS[request.generationType] ?? request.generationType;
  const instruction =
    GENERATION_TYPE_INSTRUCTIONS[request.generationType] ??
    GENERATION_TYPE_INSTRUCTIONS.custom;

  const context = request.context ?? {};
  const contextBlock = Object.keys(context).length
    ? `\n\nProject context (JSON):\n${JSON.stringify(context).slice(0, 12_000)}`
    : '';

  return [
    {
      role: 'system',
      content: [
        'You are NovelForge, an expert fiction-writing assistant.',
        `Task: produce the ${label}.`,
        instruction,
        'Return only the requested content: no preamble, no explanations, no markdown fences.',
      ].join(' '),
    },
    { role: 'user', content: `${request.prompt}${contextBlock}` },
  ];
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Coerces whatever a registered handler returned into a GenerationResult. */
function normalizeHandlerResult(value: unknown): GenerationResult {
  if (value && typeof value === 'object') {
    const candidate = value as Partial<GenerationResult>;
    if (candidate.meta && typeof candidate.meta === 'object' && 'source' in candidate.meta) {
      return candidate as GenerationResult;
    }
    if (typeof (value as { text?: unknown }).text === 'string') {
      return {
        text: (value as { text: string }).text,
        meta: { source: 'agnes', model: 'unknown', usedFallback: false },
      };
    }
    return {
      structuredData: value as Record<string, unknown>,
      meta: { source: 'agnes', model: 'unknown', usedFallback: false },
    };
  }
  if (typeof value === 'string') {
    return { text: value, meta: { source: 'agnes', model: 'unknown', usedFallback: false } };
  }
  return { meta: { source: 'agnes', model: 'unknown', usedFallback: false } };
}

export class UniversalGenerationService {
  /**
   * Creates a durable generation job and returns its id.
   *
   * The queue is the only writer of `generation_jobs` rows, so creation,
   * idempotency and dispatch cannot diverge between the universal engine and
   * the legacy services.
   */
  static async createJob(input: GenerationRequestInput | GenerationRequest): Promise<string> {
    const request: GenerationRequest = validateGenerationRequest(input);
    const { enqueue } = await import('@/lib/queue');

    return enqueue({
      type: request.generationType,
      userId: request.userId,
      novelId: request.projectId,
      chapterId: request.targetId ?? null,
      payload: {
        engine: UNIVERSAL_ENGINE,
        prompt: request.prompt,
        context: request.context ?? {},
        ...(request.customType ? { customType: request.customType } : {}),
        ...(request.targetType ? { targetType: request.targetType } : {}),
        provider: request.provider ?? null,
        model: request.model ?? null,
        stream: request.stream === true,
        metadata: request.metadata ?? {},
      },
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
    });
  }

  /**
   * Worker entry point: executes one claimed generation job.
   *
   * Contract:
   *  - returns the result; never writes a terminal job status (the worker does);
   *  - throws on failure so the worker applies retry/backoff classification;
   *  - honours `context.signal` and `context.isCancelled()`.
   */
  static async executeJob(
    jobId: string,
    request: GenerationRequest,
    context: GenerationExecutionContext,
  ): Promise<GenerationResult> {
    if (!jobId) throw new Error('executeJob requires the generation job id.');

    const job = getDb()
      .prepare('SELECT id,userId,novelId,chapterId,taskType,payload,status FROM generation_jobs WHERE id=?')
      .get(jobId) as
      | { id: string; userId: string; novelId: string; chapterId: string | null; taskType: string; payload: string | null; status: string }
      | undefined;
    if (!job) throw new Error(`Generation job ${jobId} no longer exists.`);

    // Defence in depth: the persisted row is authoritative, so a mismatched
    // request can never generate into another user's project.
    if (job.userId !== request.userId || job.novelId !== request.projectId) {
      throw Object.assign(new Error('Generation request does not match its persisted job.'), {
        retryable: false,
        code: 'job_request_mismatch',
      });
    }
    if (!isUniversalEngineJob(job)) {
      throw Object.assign(
        new Error('This generation job is not owned by the universal engine and cannot be executed by it.'),
        { retryable: false, code: 'engine_mismatch' },
      );
    }
    if (job.status !== 'processing') {
      throw Object.assign(new Error('Generation was cancelled before execution.'), {
        retryable: false,
        code: 'cancelled',
      });
    }

    const result = await UniversalGenerationService.run(jobId, request, context);
    recordGenerationProvenance(jobId, result.meta);
    return result;
  }

  private static async run(
    jobId: string,
    request: GenerationRequest,
    context: GenerationExecutionContext,
  ): Promise<GenerationResult> {
    // 1. A registered handler replaces the built-in behaviour for this type
    //    (features can register their own pipeline).
    const handler = GenerationRegistry.getHandler(request.generationType);
    if (handler) {
      context.setStage('PREPARING_GENERATION', {
        generationType: request.generationType,
        handler: 'registered',
      });
      const raw = await handler(request, context);
      return normalizeHandlerResult(raw);
    }

    // 2. Built-in paths. Image is the only non-text modality.
    if (request.generationType === 'image') {
      return UniversalGenerationService.handleImageGeneration(jobId, request, context);
    }

    const wantsJson =
      request.metadata?.responseFormat === 'json' ||
      (request.context as Record<string, unknown> | undefined)?.responseFormat === 'json';
    if (wantsJson) {
      return UniversalGenerationService.handleStructuredGeneration(jobId, request, context);
    }

    return UniversalGenerationService.handleTextGeneration(jobId, request, context);
  }

  /**
   * Built-in text generation with real provider streaming.
   *
   * Every provider adapter reports *cumulative* text through `onText`; the delta
   * is computed here so each persisted chunk carries only new content.
   */
  private static async handleTextGeneration(
    jobId: string,
    request: GenerationRequest,
    context: GenerationExecutionContext,
  ): Promise<GenerationResult> {
    const messages = buildMessages(request);
    const chain = resolveProviderChain(request);
    const streamingRequested = request.stream === true;

    if (chain.length === 0) {
      if (!allowStubOutput()) {
        throw Object.assign(
          new Error(
            'No AI provider is configured. Set AGNES_API_KEY, HF_TOKEN or OPENAI_API_KEY on the server.',
          ),
          { retryable: false, code: 'provider_not_configured' },
        );
      }
    }

    const label = GENERATION_TYPE_LABELS[request.generationType];
    context.setStage('CONNECTING_TO_AI_PROVIDER', { generationType: request.generationType });

    const sink: ChunkSink | null = streamingRequested ? openChunkSink(jobId) : null;
    let streaming = false;
    let announcedStreaming = false;
    let lastError: unknown;
    let firstFailureReason: string | undefined;

    const providerChain: GenerationProvider[] = chain.length ? chain : ['agnes'];

    for (let index = 0; index < providerChain.length; index++) {
      const provider = providerChain[index];
      const isLastProvider = index === providerChain.length - 1;

      let previous = 0;
      const onText = streamingRequested && sink
        ? (cumulative: string) => {
            if (context.isCancelled() || context.signal.aborted) {
              throw Object.assign(new Error('Generation was cancelled.'), {
                retryable: false,
                code: 'cancelled',
              });
            }
            // Adapters emit cumulative text; persist only the new suffix.
            if (cumulative.length <= previous) return;
            const delta = cumulative.slice(previous);
            previous = cumulative.length;
            sink.append(delta);
            streaming = true;
            if (!announcedStreaming) {
              announcedStreaming = true;
              context.setStage('STREAMING_CONTENT', { generationType: request.generationType });
            }
            context.setProgress(Math.min(90, Math.floor(sink.text.length / 60)));
          }
        : undefined;

      try {
        const result = await generateTextDetailed({
          messages,
          ...(request.model ? { model: request.model } : {}),
          userId: request.userId,
          novelId: request.projectId,
          ...(request.targetId ? { chapterId: request.targetId } : {}),
          jobId,
          taskType: request.customType ?? request.generationType,
          ...(context.signal ? { signal: context.signal } : {}),
          forceProvider: provider,
          // The engine owns the fallback chain, so the provider layer must not
          // silently substitute a stub.
          allowFallbackOnError: false,
          ...(onText ? { onText } : {}),
        });

        if (result.meta.source === 'demo' || result.meta.source === 'fallback') {
          if (!allowStubOutput()) {
            throw Object.assign(
              new Error(
                `A real AI provider is required to generate a ${label.toLowerCase()}. Configure a provider and retry.`,
              ),
              { retryable: false, code: 'provider_unavailable' },
            );
          }
        }

        if (!result.text || !result.text.trim()) {
          throw Object.assign(new Error('The model returned an empty response.'), { code: 'empty_response' });
        }

        if (streaming && sink && sink.text.length > 0) {
          context.setStage('SAVING_RESULT', { generationType: request.generationType });
        }
        context.setProgress(100);

        return {
          text: result.text,
          meta: {
            source: result.meta.source,
            model: result.meta.model,
            actualModel: result.meta.actualModel ?? result.meta.model,
            provider: result.meta.provider ?? provider,
            usedFallback: index > 0,
            ...(index > 0 && firstFailureReason ? { fallbackReason: firstFailureReason } : {}),
            attempts: result.meta.attempts ?? index + 1,
            latencyMs: result.meta.latencyMs,
            ...(streaming ? { usage: { streamed: true, chunks: sink?.sequence ?? 0 } } : {}),
          },
        };
      } catch (err) {
        lastError = err;
        const anyErr = err as { retryable?: boolean; code?: string };
        if (anyErr?.code === 'cancelled') throw err;
        if (context.isCancelled()) {
          throw Object.assign(new Error('Generation was cancelled.'), {
            retryable: false,
            code: 'cancelled',
          });
        }
        // Once real text has streamed, retrying with another provider would
        // duplicate content: fail honestly and keep what was generated.
        if (streaming) throw err;
        // A permanently-failing requested provider is reported immediately;
        // "not configured" is the one case a fallback may legitimately cover.
        if (anyErr?.retryable === false && anyErr?.code !== 'provider_not_configured') throw err;
        if (!firstFailureReason) {
          firstFailureReason = err instanceof Error ? err.message : String(err);
        }
        if (!allowFallback(request) || isLastProvider) throw err;
        console.warn(
          `[generation] ${provider} failed for ${request.generationType}, trying the next provider: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        context.setStage('CONNECTING_TO_AI_PROVIDER', { retryProvider: providerChain[index + 1] });
      }
    }

    throw lastError ?? new Error('No AI provider could serve this generation.');
  }

  /** Structured (JSON) generation used when the caller asks for it. */
  private static async handleStructuredGeneration(
    jobId: string,
    request: GenerationRequest,
    context: GenerationExecutionContext,
  ): Promise<GenerationResult> {
    context.setStage('CONNECTING_TO_AI_PROVIDER', { responseFormat: 'json' });
    const schema = z.record(z.unknown());
    const outcome = await generateStructuredDetailed(schema, {
      messages: buildMessages(request),
      ...(request.model ? { model: request.model } : {}),
      userId: request.userId,
      novelId: request.projectId,
      ...(request.targetId ? { chapterId: request.targetId } : {}),
      jobId,
      taskType: request.customType ?? request.generationType,
      ...(context.signal ? { signal: context.signal } : {}),
      fallback: {},
      retries: 2,
    });

    if (outcome.meta.source === 'fallback' && !allowStubOutput()) {
      throw Object.assign(
        new Error('The provider did not return usable structured output. Please retry.'),
        { code: 'structured_output_invalid' },
      );
    }
    if (outcome.meta.source === 'demo' && !allowStubOutput()) {
      throw Object.assign(
        new Error('No AI provider is configured for structured generation.'),
        { retryable: false, code: 'provider_not_configured' },
      );
    }

    context.setStage('SAVING_RESULT', { responseFormat: 'json' });
    context.setProgress(100);
    return {
      structuredData: outcome.data as Record<string, unknown>,
      meta: {
        source: outcome.meta.source,
        model: outcome.meta.model,
        actualModel: outcome.meta.actualModel ?? outcome.meta.model,
        provider: outcome.meta.provider,
        usedFallback: outcome.meta.usedFallback,
        ...(outcome.meta.fallbackReason ? { fallbackReason: outcome.meta.fallbackReason } : {}),
        attempts: outcome.meta.attempts,
        latencyMs: outcome.meta.latencyMs,
      },
    };
  }

  /**
   * Image generation. Asynchronous by nature: there are no text chunks, so this
   * path reports stages and progress instead of pretending to stream.
   *
   * The final job id is the image job's own id (never a project/novel id), so
   * the worker finalises the right row.
   */
  private static async handleImageGeneration(
    jobId: string,
    request: GenerationRequest,
    context: GenerationExecutionContext,
  ): Promise<GenerationResult> {
    const width = Math.round(toNumber(request.context?.width, 1024));
    const height = Math.round(toNumber(request.context?.height, 1024));

    context.setStage('GENERATING_IMAGE', { width, height });
    context.setProgress(10);

    const output = await generateImage({
      prompt: request.prompt,
      ...(request.model && request.model !== 'auto' ? { modelId: request.model } : {}),
      width,
      height,
      userId: request.userId,
      novelId: request.projectId,
      jobId,
      taskType: request.customType ?? 'image',
      ...(context.signal ? { signal: context.signal } : {}),
      allowFallback: allowFallback(request),
    });

    context.setProgress(70);
    context.setStage('SAVING_RESULT', { provider: output.provider });

    const ext = output.mimeType === 'image/jpeg' ? 'jpg' : output.mimeType === 'image/webp' ? 'webp' : 'png';
    const stored = await saveFile({ data: output.image, folder: 'images', ext });

    const imageId = nanoid();
    const now = new Date().toISOString();
    try {
      getDb()
        .prepare(
          `INSERT INTO image_assets (id,novelId,userId,kind,provider,storageKey,url,width,height,prompt,isPrimary,meta,format,bytes,model,requestedModel,createdAt,updatedAt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          imageId,
          request.projectId,
          request.userId,
          'generated',
          output.provider,
          stored.key,
          stored.url,
          output.width || width,
          output.height || height,
          request.prompt,
          0,
          JSON.stringify({ generationType: request.generationType, jobId }),
          ext,
          output.image.length,
          output.actualModelId ?? null,
          output.requestedModelId ?? null,
          now,
          now,
        );
    } catch (err) {
      // The image exists in storage; a bookkeeping failure must not lose it.
      console.error('[generation] could not record image asset', err);
    }

    context.setProgress(100);
    return {
      assets: {
        imageId,
        url: stored.url,
        key: stored.key,
        width: output.width || width,
        height: output.height || height,
        mimeType: output.mimeType,
      },
      meta: {
        source: output.provider?.includes('hugging') ? 'huggingface' : 'agnes',
        model: output.actualModelId ?? request.model ?? 'auto',
        actualModel: output.actualModelId,
        provider: output.provider,
        usedFallback: output.fallbackUsed === true,
        attempts: output.attempts,
        latencyMs: output.latencyMs,
        ...(output.cost ? { cost: output.cost as unknown as Record<string, unknown> } : {}),
      },
    };
  }

  /**
   * Cancellation. The durable row is the single source of truth; the worker's
   * cancel poll observes it and aborts the provider request.
   */
  static async cancel(jobId: string, reason?: string): Promise<boolean> {
    const { cancelJob } = await import('@/lib/queue');
    void reason;
    return cancelJob(jobId);
  }

  /** Re-queues a failed or cancelled universal job. */
  static async retryJob(jobId: string): Promise<boolean> {
    const { retryJob } = await import('@/lib/queue');
    return retryJob(jobId);
  }

  /** True when the persisted job belongs to this engine (payload marker). */
  static ownsJob(job: { payload?: string | null } | null | undefined): boolean {
    return isUniversalEngineJob(job as { payload?: string | null });
  }

  /** Absolute provider order, exposed for diagnostics/tests. */
  static providerOrder(): GenerationProvider[] {
    return ['agnes', 'huggingface', 'openai'];
  }

  /** Parses a persisted payload (used by the worker and the SSE snapshot). */
  static parsePayload(payload: string | null | undefined): Record<string, unknown> {
    return parseJobPayload(payload);
  }
}
