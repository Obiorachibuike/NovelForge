import { requireUser } from '@/lib/db/ownership';
import { apiHandler, readJsonBody, MAX_JSON_BYTES } from '@/lib/api/http';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { assertRegisteredModelOrAgnes } from '@/lib/ai/model-selection';
import { generateTextHuggingFace } from '@/lib/ai/hf-text-generation';
import { generateTextAgnes, AgnesHttpError } from '@/lib/ai/agnes-generation';
import { classifyAiError } from '@/lib/ai/error-classifier';
import { agnesBackendActive, hostedBackendActive, isExplicitHuggingFaceModel } from '@/lib/ai/text-generation';
import { huggingFaceConfigured } from '@/lib/ai/config';
import { HttpError } from '@/lib/api/http';
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

/** Wraps a non-HTTP provider failure into a user-safe HttpError. */
function asHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const info = classifyAiError(err, { modelId: 'agnes', task: 'text-generation' });
  return new HttpError(info.status ?? 502, info.userMessage, info.category, {});
}

/**
 * Direct text generation through the hosted-inference layer.
 *
 * Agnes AI is the primary provider; Hugging Face hosted inference is the
 * fallback chain. The model id is validated (Hugging Face registry, or an Agnes
 * model id), so this endpoint can never be used to proxy an arbitrary
 * repository.
 */
export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  if (!hostedBackendActive()) {
    return Response.json(
      {
        error: 'Hosted inference is not configured. Set AGNES_API_KEY (primary) or HF_TOKEN (fallback) to enable this endpoint.',
        code: 'hosted_inference_not_configured',
      },
      { status: 503 },
    );
  }

  enforceAiRateLimit('text', user.id);
  const body = await readJsonBody(req, v => bodySchema.parse(v), MAX_JSON_BYTES.default);
  const modelId = assertRegisteredModelOrAgnes(body.modelId, 'text-generation');

  const messages = [
    ...(body.systemPrompt ? [{ role: 'system' as const, content: body.systemPrompt }] : []),
    { role: 'user' as const, content: body.prompt },
  ];

  // ── Agnes AI (primary) ─────────────────────────────────────────────────────
  // Skipped when the caller explicitly picked a Hugging Face repository.
  if (agnesBackendActive() && !isExplicitHuggingFaceModel(modelId)) {
    try {
      const result = await generateTextAgnes({
        messages,
        ...(modelId !== 'auto' ? { model: modelId } : {}),
        temperature: body.temperature ?? 0.8,
        maxTokens: body.maxNewTokens ?? 1_024,
        ...(typeof body.topP === 'number' ? { topP: body.topP } : {}),
        userId: user.id,
        novelId: body.novelId,
        taskType: body.taskType ?? 'api:text',
      });
      return Response.json({
        text: result.text,
        requestedModelId: result.requestedModel,
        actualModelId: result.model,
        provider: result.provider,
        fallbackUsed: false,
        attempts: result.attempts,
        latencyMs: result.latencyMs,
        usage: result.usage ?? null,
        cost: result.cost ?? { status: 'unknown' },
        trail: [{ modelId: result.model, provider: result.provider, category: 'success', latencyMs: result.latencyMs }],
      });
    } catch (err) {
      const reason = err instanceof AgnesHttpError ? `Agnes AI request failed (${err.status})` : err instanceof Error ? err.message : String(err);
      if (!body.allowFallback || !huggingFaceConfigured()) {
        throw asHttpError(err);
      }
      console.warn(`[ai] ${body.taskType ?? 'api:text'}: Agnes AI failed, falling back to Hugging Face — ${reason}`);
    }
  }

  // ── Hugging Face (active backend or fallback chain) ────────────────────────
  const result = await generateTextHuggingFace({
    messages,
    // Only an explicit Hugging Face repo id reaches the HF chain; an Agnes id
    // that failed above falls through with 'auto' so selection picks a
    // registered fallback model.
    ...(modelId.includes('/') ? { model: modelId } : {}),
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
