import { requireUser, requireNovel } from '@/lib/db/ownership';
import { apiHandler, readJsonBody, HttpError } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { assertRegisteredModelOrAgnes } from '@/lib/ai/model-selection';
import {
  createChapterGeneration,
  listGenerations,
  maxActiveGenerationsPerNovel,
  maxActiveGenerationsPerUser,
  serializeGeneration,
} from '@/lib/jobs/generation-jobs';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const createSchema = z.object({
  novelId: z.string().min(1).max(64),
  chapterId: z.string().min(1).max(64).optional(),
  chapterNumber: z.coerce.number().int().min(1).max(1000).optional(),
  confirmOverwrite: z.boolean().default(false),
  textModel: z.string().max(200).optional(),
  allowFallback: z.boolean().default(true),
});

const listQuerySchema = z.object({
  active: z.enum(['true', 'false', '1', '0']).optional(),
  novelId: z.string().max(64).optional(),
  chapterId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * POST /api/generations
 *
 * Validates the caller, novel ownership and the sequential-writing gate, then
 * creates a durable generation record and hands only its id to pg-boss.
 * Returns immediately — generation itself happens in the dedicated worker.
 */
export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  enforceRateLimit('aiGeneration', user.id);
  enforceAiRateLimit('text', user.id);

  const body = await readJsonBody(req, v => createSchema.parse(v));
  await requireNovel(body.novelId, user.id);

  if (body.chapterId) {
    // Chapter ids are only accepted when they belong to the owned novel.
    const { getDb } = await import('@/lib/db');
    const chapter = getDb()
      .prepare(
        'SELECT c.id FROM chapters c JOIN novels n ON n.id=c.novelId WHERE c.id=? AND c.novelId=? AND n.userId=?',
      )
      .get(body.chapterId, body.novelId, user.id);
    if (!chapter) throw new HttpError(404, 'Chapter not found', 'chapter_not_found');
  }

  const textModel = assertRegisteredModelOrAgnes(body.textModel, 'text-generation');
  const result = await createChapterGeneration(user.id, {
    novelId: body.novelId,
    chapterId: body.chapterId,
    chapterNumber: body.chapterNumber,
    confirmOverwrite: body.confirmOverwrite,
    ...(textModel !== 'auto' ? { textModel } : {}),
    allowFallback: body.allowFallback,
  });

  return Response.json(
    {
      ok: true,
      jobId: result.jobId,
      generationId: result.jobId,
      chapterNumber: result.chapterNumber,
      status: result.generation.status,
      generation: result.generation,
      statusUrl: `/api/generations/${result.jobId}`,
      eventsUrl: `/api/generations/${result.jobId}/events`,
      cancelUrl: `/api/generations/${result.jobId}/cancel`,
      retryUrl: `/api/generations/${result.jobId}/retry`,
    },
    { status: 202 },
  );
});

/**
 * GET /api/generations — the caller's own generation history and active jobs.
 * There is no way to read another user's rows: `userId` comes from the session.
 */
export const GET = apiHandler(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const parsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.errors[0]?.message || 'Invalid query', 'validation_failed');
  }
  const q = parsed.data;
  if (q.novelId) await requireNovel(q.novelId, user.id);

  const active = q.active === 'true' || q.active === '1';
  const rows = listGenerations(user.id, {
    active,
    novelId: q.novelId,
    chapterId: q.chapterId,
    limit: q.limit ?? 25,
  });
  const activeRows = active
    ? rows
    : listGenerations(user.id, { active: true, novelId: q.novelId, limit: 100 });

  return Response.json(
    {
      generations: rows.map(serializeGeneration),
      activeGenerations: activeRows.map(serializeGeneration),
      count: rows.length,
      activeCount: activeRows.length,
      limits: {
        maxActivePerUser: maxActiveGenerationsPerUser(),
        maxActivePerNovel: maxActiveGenerationsPerNovel(),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
