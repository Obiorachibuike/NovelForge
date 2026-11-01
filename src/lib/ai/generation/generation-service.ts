import 'server-only';
import { GenerationRequest, GenerationResult, GenerationChunk } from './generation-types';
import { GenerationRegistry } from './generation-registry';
import { createGenerationJob, persistChunk, finalizeJob, cancelJob } from './generation-persistence';
import { validateGenerationRequest } from './generation-validation';
import { classifyJobError } from '@/lib/queue';
import { generateTextDetailed, streamText, generateStructuredDetailed } from '@/lib/ai/text-generation';
import { generateTextAgnes, generateStructuredAgnes } from '@/lib/ai/agnes-generation';
import { generateTextHuggingFace, generateStructuredHuggingFace } from '@/lib/ai/hf-text-generation';
import { generateImageAgnes } from '@/lib/ai/agnes-generation';
import { agnesBackendActive, huggingFaceBackendActive, hostedBackendActive } from '@/lib/ai/text-generation';
import { aiConfig } from '@/lib/ai/provider';
import { ChatMessage } from '@/types';

/**
 * UniversalGenerationService
 *
 * Central engine that handles:
 * 1. Job creation (persistence)
 * 2. Provider selection & capability detection
 * 3. Real-time incremental streaming (where supported)
 * 4. Background execution (via pg-boss & worker)
 * 5. Chunk persistence & event publishing
 * 6. Cancellation & retry
 */
export class UniversalGenerationService {
  /**
   * Creates a generation job and returns the ID.
   * The worker will pick it up.
   */
  static async createJob(request: GenerationRequest): Promise<string> {
    const validated = validateGenerationRequest(request);
    return createGenerationJob(validated);
  }

  /**
   * Worker handler: executes the generation.
   * Supports streaming for text generation.
   */
  static async executeJob(
    jobId: string,
    request: GenerationRequest,
    context: {
      setStage: (stage: string, data?: Record<string, unknown>) => void;
      setProgress: (percent: number) => void;
      isCancelled: () => boolean;
      signal: AbortSignal;
    }
  ): Promise<GenerationResult> {
    const { generationType, prompt, context: genContext, provider, model, stream, userId, projectId, targetId } = request;

    // Check if registered handler exists (allows future extensions)
    const handler = GenerationRegistry.getHandler(generationType);
    if (handler) {
      // Custom registered handler
      return await handler(request);
    }

    // Fallback to core implementations for migrated types
    switch (generationType) {
      case 'chapter':
      case 'chapter_outline':
      case 'story_outline':
      case 'novel_summary':
      case 'novel_description':
      case 'novel_title':
      case 'story_idea':
      case 'character':
      case 'character_backstory':
      case 'worldbuilding':
      case 'location':
      case 'culture':
      case 'history':
      case 'rewrite':
      case 'expand':
      case 'summarize':
      case 'shorten':
      case 'proofread':
      case 'humanize':
      case 'premise':
      case 'outline':
        return await this.handleTextGeneration(request, context);

      case 'image':
        return await this.handleImageGeneration(request, context);

      default:
        throw new Error(`No handler registered for generation type: ${generationType}`);
    }
  }

  /**
   * Core text generation with streaming support.
   */
  private static async handleTextGeneration(
    request: GenerationRequest,
    context: {
      setStage: (stage: string, data?: Record<string, unknown>) => void;
      setProgress: (percent: number) => void;
      isCancelled: () => boolean;
      signal: AbortSignal;
    }
  ): Promise<GenerationResult> {
    const { prompt, userId, projectId, targetId, generationType, provider, model, stream } = request;

    // Construct messages (simplified for universal engine - services will pass specific prompts)
    const messages: ChatMessage[] = [
      { role: 'system', content: `You are generating content for ${generationType}. Follow the context provided.` },
      { role: 'user', content: prompt },
    ];

    // Capability detection
    const isStreamingSupported = stream && (agnesBackendActive() || huggingFaceBackendActive());

    if (isStreamingSupported && generationType !== 'image') {
      // Real provider streaming
      context.setStage('GENERATING_CONTENT');
      let accumulatedText = '';
      let sequence = 0;

      // Choose provider adapter
      const input = {
        messages,
        model,
        userId,
        novelId: projectId,
        chapterId: targetId,
        jobId: jobId,
        taskType: generationType,
        signal: context.signal,
        onText: (chunk: string) => {
          if (context.isCancelled()) throw new Error('Cancelled');
          sequence++;
          accumulatedText += chunk;
          persistChunk(jobId, sequence, chunk);
          context.setStage('STREAMING_CONTENT', { chunk });
        },
      };

      // Provider routing
      let result: GenerationResult;
      if (agnesBackendActive() && !provider?.includes('huggingface')) {
        // Agnes streaming (via chat-stream adapter)
        // Note: agnesChatCompletion supports onText in agnes-generation.ts
        const agnesInput = { ...input, model: model || aiConfig.textModel, maxTokens: 4096 };
        const completion = await generateTextAgnes(agnesInput);
        result = {
          text: accumulatedText || completion.text,
          meta: {
            source: 'agnes',
            model: completion.model,
            actualModel: completion.model,
            provider: 'agnes-ai',
            usedFallback: false,
            attempts: completion.attempts,
            latencyMs: completion.latencyMs,
            usage: completion.usage,
            cost: completion.cost,
          },
        };
      } else if (huggingFaceBackendActive()) {
        // HF streaming
        const hfInput = { ...input, model: model || 'auto', allowModelFallback: true };
        const completion = await generateTextHuggingFace(hfInput);
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
        // OpenAI or fallback
        const openaiInput = { ...input, model: model || aiConfig.textModel };
        const completion = await generateTextDetailed(openaiInput);
        result = {
          text: accumulatedText || completion.text,
          meta: completion.meta,
        };
      }

      finalizeJob(jobId, 'completed', result);
      return result;

    } else {
      // Non-streaming or image generation fallback
      context.setStage('PROCESSING');
      let result: GenerationResult;

      switch (generationType) {
        case 'image':
          result = await this.handleImageGeneration(request, context);
          break;
        default:
          // Standard text generation (non-streaming or provider without streaming)
          const input = {
            messages,
            model,
            userId,
            novelId: projectId,
            chapterId: targetId,
            jobId,
            taskType: generationType,
            signal: context.signal,
            allowFallbackOnError: false,
          };
          result = await generateTextDetailed(input);
      }

      finalizeJob(jobId, 'completed', result);
      return result;
    }
  }

  /**
   * Image generation (asynchronous, no text streaming)
   */
  private static async handleImageGeneration(
    request: GenerationRequest,
    context: {
      setStage: (stage: string, data?: Record<string, unknown>) => void;
      setProgress: (percent: number) => void;
      isCancelled: () => boolean;
      signal: AbortSignal;
    }
  ): Promise<GenerationResult> {
    const { prompt, userId, projectId, model } = request;
    context.setStage('GENERATING_IMAGE');

    const input = {
      prompt,
      model,
      userId,
      novelId: projectId,
      jobId: context.signal?.aborted ? null : undefined, // injected in service
      taskType: 'image',
      signal: context.signal,
    };

    const output = await generateImageAgnes(input as any);

    const result: GenerationResult = {
      meta: {
        source: 'agnes',
        model: output.model,
        provider: 'agnes-ai',
        usedFallback: false,
        attempts: output.attempts,
        latencyMs: output.latencyMs,
        cost: output.cost,
      },
    };

    finalizeJob(request.projectId, 'completed', result);
    return result;
  }

  /**
   * Cancellation
   */
  static cancel(jobId: string, reason?: string) {
    return cancelJob(jobId, reason);
  }
}
