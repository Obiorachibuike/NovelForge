import { requireUser } from '@/lib/db/ownership';
import { apiHandler, readJsonBody, MAX_JSON_BYTES } from '@/lib/api/http';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { assertRegisteredModel } from '@/lib/ai/model-selection';
import { generateImageHuggingFace } from '@/lib/ai/image-generation';
import { aiPolicy } from '@/lib/ai/config';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  prompt: z.string().min(3, 'A prompt of at least 3 characters is required.').max(2_000),
  negativePrompt: z.string().max(1_000).optional(),
  modelId: z.string().max(200).optional(),
  width: z.coerce.number().int().min(256).max(2_048).optional(),
  height: z.coerce.number().int().min(256).max(2_048).optional(),
  allowFallback: z.boolean().default(true),
  novelId: z.string().max(64).optional(),
});

/**
 * Direct image generation through the hosted-inference layer.
 *
 * Returns validated image bytes as base64 (never a raw provider error, never
 * an unvalidated payload). Image requests only fall back to other image models.
 */
export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  const policy = aiPolicy();
  if (policy.backend !== 'huggingface') {
    return Response.json(
      { error: 'Hugging Face hosted inference is not configured. Set HF_TOKEN to enable this endpoint.', code: 'hf_not_configured' },
      { status: 503 },
    );
  }

  enforceAiRateLimit('image', user.id);
  const body = await readJsonBody(req, v => bodySchema.parse(v), MAX_JSON_BYTES.default);
  const modelId = assertRegisteredModel(body.modelId, 'text-to-image');

  const result = await generateImageHuggingFace({
    prompt: body.prompt,
    negativePrompt: body.negativePrompt,
    ...(modelId !== 'auto' ? { modelId } : {}),
    width: body.width ?? 768,
    height: body.height ?? 1024,
    allowFallback: body.allowFallback,
    userId: user.id,
    novelId: body.novelId,
    taskType: 'api:image',
  });

  return Response.json({
    imageBase64: result.image.toString('base64'),
    mimeType: result.mimeType,
    width: result.width ?? body.width ?? 768,
    height: result.height ?? body.height ?? 1024,
    requestedModelId: result.requestedModelId,
    actualModelId: result.actualModelId,
    provider: result.provider ?? null,
    fallbackUsed: result.fallbackUsed,
    attempts: result.attempts,
    latencyMs: result.latencyMs,
    cost: result.cost ?? { status: 'unknown' },
    trail: result.attempts_detail ?? [],
  });
});
