/**
 * Hugging Face text-to-image generation with task-compatible fallback.
 *
 * Image requests only ever fall back to other *image* models — never to a text
 * model. Output is validated (real image bytes, magic-number sniffed) before it
 * is returned, so a JSON error body served with HTTP 200 can never be stored as
 * a cover.
 */
import 'server-only';
import { aiPolicy } from './config';
import { orchestrateGeneration } from './fallback-orchestrator';
import { hfGenerateImage, sniffImageMime } from './huggingface-client';
import { validateImageBuffer } from './output-validation';
import { toImageResult } from './fallback-orchestrator';
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
