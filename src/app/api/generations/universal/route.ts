import 'server-only';
import { z } from 'zod';
import { apiHandler, readJsonBody, HttpError } from '@/lib/api/http';
import { requireUser, requireNovel } from '@/lib/db/ownership';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';

import { validateGenerationInput } from '@/lib/ai/generation/generation-validation';
import { UniversalGenerationService } from '@/lib/ai/generation/generation-service';
import {
  getGenerationForUser,
  listGenerationsForUser,
  serializeGeneration,
} from '@/lib/jobs/generation-jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/generations/universal
 *
 * Creates one durable generation job of *any* supported type (novel title,
 * chapter outline, scene, character, rewrite, image, custom, ...) and returns
 * immediately. The dedicated worker performs the generation; the returned
 * `eventsUrl` streams persisted progress/content over SSE, and neither depends
 * on the browser staying open.
 */
export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  enforceRateLimit('aiGeneration', user.id);
  enforceAiRateLimit('text', user.id);

  // `validateGenerationInput` validates the public body and replaces any
  // client-supplied owner with the authenticated user: ownership can only come
  // from the session.
  const request = await readJsonBody(req, value => validateGenerationInput(value, user.id));

  // A universal generation always belongs to a novel the caller owns.
  await requireNovel(request.projectId, user.id);

  const jobId = await UniversalGenerationService.createJob(request);

  const job = getGenerationForUser(user.id, jobId);
  if (!job) throw new HttpError(500, 'Job creation failed', 'generation_missing');

  return Response.json(
    {
      ok: true,
      jobId,
      generationId: jobId,
      generation: serializeGeneration(job),
      statusUrl: `/api/generations/${jobId}`,
      eventsUrl: `/api/generations/${jobId}/events`,
      cancelUrl: `/api/generations/${jobId}/cancel`,
      retryUrl: `/api/generations/${jobId}/retry`,
    },
    { status: 202 },
  );
});

const listQuerySchema = z.object({
  active: z.enum(['true', 'false', '1', '0']).optional(),
  projectId: z.string().min(1).max(128).optional(),
  targetId: z.string().min(1).max(128).optional(),
  generationType: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * GET /api/generations/universal
 *
 * The caller's generations of every type. Used by the global generation panel to
 * restore state after a navigation or a full browser refresh.
 */
export const GET = apiHandler(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);

  const parsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.errors[0]?.message || 'Invalid query', 'validation_failed');
  }
  const query = parsed.data;
  if (query.projectId) await requireNovel(query.projectId, user.id);

  const rows = listGenerationsForUser(user.id, {
    ...(query.active === 'true' || query.active === '1' ? { active: true } : {}),
    ...(query.projectId ? { novelId: query.projectId } : {}),
    ...(query.targetId ? { chapterId: query.targetId } : {}),
    ...(query.generationType ? { taskType: query.generationType } : {}),
    limit: query.limit ?? 25,
  });

  return Response.json(
    { generations: rows.map(serializeGeneration), count: rows.length },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
