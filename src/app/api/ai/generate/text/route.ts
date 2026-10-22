import { requireUser } from '@/lib/db/ownership';
import { apiHandler, readJsonBody, MAX_JSON_BYTES } from '@/lib/api/http';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { assertRegisteredModel } from '@/lib/ai/model-selection';
import { generateTextHuggingFace } from '@/lib/ai/hf-text-generation';
import { aiPolicy } from '@/lib/ai/config';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  prompt: z.string().min(1, 'A prompt is required.').max(12_000),
  systemPrompt: z.string().max(6_000).optional(),
  modelId: z.string().max(200).optional(),
  maxNewTokens: z.coerce.number().int().min(16).max(8_000).optional(),
  temperature: z.coerce.number().min(0).max(2).optional(),
  topP: z.coerce.number().min(0).max(1).optional(),
  allowFallback: z.boolean().default(true),
  novelId: z.string().max(64).optional(),
  taskType: z.string().max(60).optional(),
});

/**
 * Direct text generation through the hosted-inference layer.
 *
 * Used by the model dashboard's "try this model" control and by internal tools.
 * The model id is validated against the registry, so this endpoint can never be
 * used to proxy an arbitrary Hugging Face repository.
 */
export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  const policy = aiPolicy();
  if (policy.backend !== 'huggingface') {
    return Response.json(
      {
        error: 'Hugging Face hosted inference is not configured. Set HF_TOKEN to enable this endpoint.',
        code: 'hf_not_configured',
      },
      { status: 503 },
    );
  }

  enforceAiRateLimit('text', user.id);
  const body = await readJsonBody(req, v => bodySchema.parse(v), MAX_JSON_BYTES.default);
  const modelId = assertRegisteredModel(body.modelId, 'text-generation');

  const result = await generateTextHuggingFace({
    messages: [
      ...(body.systemPrompt ? [{ role: 'system' as const, content: body.systemPrompt }] : []),
      { role: 'user' as const, content: body.prompt },
    ],
    ...(modelId !== 'auto' ? { model: modelId } : {}),
    temperature: body.temperature ?? 0.8,
    maxTokens: body.maxNewTokens ?? 1_024,
    userId: user.id,
    novelId: body.novelId,
    taskType: body.taskType ?? 'api:text',
    allowFallback: body.allowFallback,
  });

  return Response.json({
    text: result.text,
    requestedModelId: result.requestedModel,
    actualModelId: result.model,
    provider: result.provider ?? null,
    fallbackUsed: result.fallbackUsed,
    attempts: result.attempts,
    latencyMs: result.latencyMs,
    usage: result.usage ?? null,
    cost: result.cost ?? { status: 'unknown' },
    trail: result.trail,
  });
});
