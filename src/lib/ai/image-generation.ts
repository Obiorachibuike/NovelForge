/**
 * Text-to-image generation.
 *
 * Agnes AI (`agnes-image-2.5-flash`) is the primary provider; hosted Hugging
 * Face inference is the fallback. Within each provider, image requests only
 * ever fall back to other *image* models — never to a text model. Output is
 * validated (real image bytes, magic-number sniffed) before it is returned, so
 * a JSON error body served with HTTP 200 can never be stored as a cover.
 */
import 'server-only';
import { aiPolicy, agnesConfigured, huggingFaceConfigured, isExplicitAgnesModel, isExplicitHuggingFaceModel } from './config';
import { orchestrateGeneration, toImageResult } from './fallback-orchestrator';
import { classifyAiError } from './error-classifier';
import { hfGenerateImage, sniffImageMime } from './huggingface-client';
import { validateImageBuffer } from './output-validation';
import { generateImageAgnes } from './agnes-generation';
import { HttpError } from '@/lib/api/http';
import type { ImageGenerationResult } from './types';

export interface GenerateImageInput {
  modelId?: string;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  signal?: AbortSignal;
  allowFallback?: boolean;
  userId?: string;
  novelId?: string;
  jobId?: string;
  taskType?: string;
}

export interface GenerateImageOutput extends ImageGenerationResult {
  transport?: string;
}

/**
 * Generates one image: Agnes AI first, Hugging Face as the fallback.
 *
 * An explicit Hugging Face repo id bypasses Agnes (the user chose that model on
 * purpose); an explicit Agnes model id skips the Hugging Face registry lookup.
 */
export async function generateImage(input: GenerateImageInput): Promise<GenerateImageOutput> {
  const hfAvailable = huggingFaceConfigured();
  const explicitAgnesModel = isExplicitAgnesModel(input.modelId);
  if (explicitAgnesModel && !agnesConfigured()) {
    throw new HttpError(400, 'An Agnes AI model was requested but AGNES_API_KEY is not configured.', 'configuration_error');
  }
  // Respect an explicit AI_BACKEND pin: Agnes is the primary provider when the
  // resolved backend is `agnes`, or when an Agnes model was requested by name.
  const agnesPrimary = explicitAgnesModel || (aiPolicy().backend === 'agnes' && !isExplicitHuggingFaceModel(input.modelId));

  if (agnesPrimary) {
    try {
      const generated = await generateImageAgnes({
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        width: input.width,
        height: input.height,
        ...(isExplicitAgnesModel(input.modelId) ? { model: input.modelId } : {}),
        signal: input.signal,
        userId: input.userId,
        novelId: input.novelId,
        jobId: input.jobId,
        taskType: input.taskType,
      });
      return {
        image: generated.buffer,
        mimeType: generated.mimeType,
        requestedModelId: input.modelId && input.modelId !== 'auto' ? input.modelId : 'auto',
        actualModelId: generated.model,
        provider: generated.provider,
        fallbackUsed: false,
        attempts: generated.attempts,
        latencyMs: generated.latencyMs,
        width: generated.width,
        height: generated.height,
        cost: generated.cost,
      };
    } catch (err) {
      if (!hfAvailable || input.allowFallback === false) {
        const info = classifyAiError(err, { modelId: input.modelId || 'agnes-image-2.5-flash', task: 'text-to-image' });
        throw new HttpError(info.status ?? 502, info.userMessage, info.category, { requestedModelId: input.modelId ?? 'auto' });
      }
      console.warn(`[ai] ${input.taskType ?? 'image'}: Agnes AI image generation failed, falling back to Hugging Face — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return generateImageHuggingFace(input);
}


/**
 * Generates one image through hosted inference.
 *
 * Dimensions are clamped to `AI_MAX_IMAGE_EDGE` because several providers
 * reject large sizes outright, and an oversized request wastes a paid call.
 */
export async function generateImageHuggingFace(input: GenerateImageInput): Promise<GenerateImageOutput> {
  const policy = aiPolicy();
  const width = clampEdge(input.width ?? 768, policy.maxImageEdge);
  const height = clampEdge(input.height ?? 1024, policy.maxImageEdge);

  const result = await orchestrateGeneration<{ buffer: Buffer; mimeType: string; width: number; height: number; transport: string; provider?: string }>({
    task: 'text-to-image',
    requestedModelId: input.modelId && input.modelId !== 'auto' ? input.modelId : 'auto',
    allowFallback: input.allowFallback,
    signal: input.signal,
    requiredSize: { width, height },
    context: {
      userId: input.userId ?? null,
      novelId: input.novelId ?? null,
      jobId: input.jobId ?? null,
      taskType: input.taskType ?? 'cover',
    },
    run: async model => {
      const generated = await hfGenerateImage({
        modelId: model.id,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        width,
        height,
        signal: input.signal,
      });
      return {
        buffer: generated.buffer,
        mimeType: generated.mimeType || sniffImageMime(generated.buffer) || 'image/png',
        width: generated.width ?? width,
        height: generated.height ?? height,
        transport: generated.transport,
        provider: generated.provider,
      };
    },
    validate: value => {
      const check = validateImageBuffer(value.buffer, { minBytes: 1_000 });
      return { ok: check.ok, reason: check.reason, category: check.category };
    },
    extract: value => ({ provider: value.provider, imageWidth: value.width, imageHeight: value.height }),
  });

  return { ...toImageResult(result), transport: result.value?.transport };
}

function clampEdge(value: number, max: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || rounded <= 0) return Math.min(768, max);
  return Math.min(rounded, max);
}
