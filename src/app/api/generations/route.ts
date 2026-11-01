import { requireUser, requireNovel } from '@/lib/db/ownership';
import { apiHandler, readJsonBody, HttpError } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { assertRegisteredModelOrAgnes } from '@/lib/ai/model-selection';
import {
  createChapterGeneration,
  listGenerations,
  getGenerationForUser,
  maxActiveGenerationsPerNovel,
  maxActiveGenerationsPerUser,
  serializeGeneration,
} from '@/lib/jobs/generation-jobs';
import { z } from 'zod';

// --- UNIVERSAL GENERATION ENGINE INTEGRATION ---
import { UniversalGenerationService } from '@/lib/ai/generation/generation-service';
import { GenerationType } from '@/lib/ai/generation/generation-types';
import { validateGenerationInput } from '@/lib/ai/generation/generation-validation';
import { GenerationRegistry } from '@/lib/ai/generation/generation-registry';

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

  // --- UNIVERSAL ENGINE DISPATCH ---
  // If the request matches the Universal Generation schema, route it there.
  // Otherwise, fall back to the legacy chapter generation logic.
  const rawBody = await readJsonBody(req, value => z.record(z.unknown()).parse(value));
  
  // Check if it's a Universal Generation Request (has generationType)
  if (typeof rawBody.generationType === 'string' && GenerationRegistry.hasHandler(rawBody.generationType as GenerationType)) {
    const body = validateGenerationInput(rawBody, user.id);
    
    // Project ownership check
    await requireNovel(body.projectId, user.id);

    // Create Universal Job
    const jobId = await UniversalGenerationService.createJob(body);

    const job = getGenerationForUser(user.id, jobId);
    if (!job) throw new HttpError(500, 'Job creation failed', 'generation_missing');

    return Response.json(
      {
        ok: true,
        jobId,
        generation: serializeGeneration(job),
        statusUrl: `/api/generations/${jobId}`,
        eventsUrl: `/api/generations/${jobId}/events`,
        cancelUrl: `/api/generations/${jobId}/cancel`,
        retryUrl: `/api/generations/${jobId}/retry`,
      },
      { status: 202 }
    );
  }

  // --- LEGACY DISPATCH (Fallback) ---
  const body = createSchema.parse(rawBody);
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
  
  // --- UNIVERSAL GENERATION QUERY ---
  // If the query asks for universal types, use the universal query logic.
  const querySchema = z.object({
    active: z.enum(['true', 'false', '1', '0']).optional(),
    projectId: z.string().max(64).optional(), // novelId
    targetId: z.string().max(64).optional(), // chapterId etc.
    limit: z.coerce.number().int().min(1).max(100).optional(),
    generationType: z.string().optional(),
  });

  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.errors[0]?.message || 'Invalid query', 'validation_failed');
  }

  const q = parsed.data;
  if (q.projectId) await requireNovel(q.projectId, user.id);

  // If generationType is provided or we're querying universal fields, use Universal logic
  if (q.generationType || q.projectId || q.targetId) {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    
    const clauses = ['j.userId = ?'];
    const args: unknown[] = [user.id];
    
    if (q.active === 'true' || q.active === '1') {
      clauses.push(`j.status IN ('queued','processing')`);
    }
    if (q.projectId) {
      clauses.push('j.novelId = ?');
      args.push(q.projectId);
    }
    if (q.targetId) {
      clauses.push('j.chapterId = ?');
      args.push(q.targetId);
    }
    if (q.generationType) {
      clauses.push('j.taskType = ?');
      args.push(q.generationType);
    }

    const limit = Math.min(100, Math.max(1, q.limit ?? 25));
    
    const GENERATION_SELECT = `
      SELECT j.*, n.title AS novelTitle, c.title AS chapterTitle, c.chapterNumber AS chapterNumber
        FROM generation_jobs j
        LEFT JOIN novels n ON n.id = j.novelId
        LEFT JOIN chapters c ON c.id = j.chapterId
    `;

    const rows = db
      .prepare(`${GENERATION_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY j.createdAt DESC LIMIT ?`)
      .all(...args, limit) as any[];

    // Serialize using existing logic (adapted for universal job row)
    const serialized = rows.map((row: any) => {
      const status = row.status;
      const publicStatus = 
        status === 'queued' ? 'QUEUED' :
        status === 'processing' ? 'PROCESSING' :
        status === 'completed' || status === 'awaiting_review' ? 'COMPLETED' :
        status === 'failed' ? 'FAILED' :
        status === 'cancelled' ? 'CANCELLED' : 'NOT_STARTED';

      return {
        id: row.id,
        novelId: row.novelId,
        novelTitle: row.novelTitle ?? null,
        chapterId: row.chapterId ?? null,
        chapterTitle: row.chapterTitle ?? null,
        chapterNumber: row.chapterNumber ?? null,
        taskType: row.taskType,
        status: publicStatus,
        progressPercentage: row.progressPercentage ?? null,
        indeterminate: row.taskType === 'chapter' && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(publicStatus),
        currentStage: row.currentStage ?? null,
        currentStageLabel: row.currentStage ? row.currentStage : null, // Simplified
        errorMessage: row.error ? String(row.error) : null,
        errorCode: row.errorCode ?? null,
        retryCount: row.attempts ?? 0,
        maxAttempts: row.maxAttempts ?? 3,
        canCancel: ['QUEUED', 'PROCESSING'].includes(publicStatus),
        canRetry: ['FAILED', 'CANCELLED'].includes(publicStatus),
        retryable: row.retryable === undefined || row.retryable === null ? true : Boolean(row.retryable),
        startedAt: row.startedAt ?? null,
        completedAt: row.completedAt ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        partialText: row.result ? (() => {
          try {
            const parsed = JSON.parse(row.result);
            return typeof parsed?.partialText === 'string' ? parsed.partialText.slice(-6000) : null;
          } catch { return null; }
        })() : null,
        requestedModel: row.requestedModel ?? null,
        actualModel: row.actualModel ?? null,
        provider: row.provider ?? null,
        eventsUrl: `/api/generations/${row.id}/events`,
        generationType: row.taskType,
      };
    });

    return Response.json(
      {
        generations: serialized,
        count: serialized.length,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // --- LEGACY DISPATCH (Fallback) ---
  const listParsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!listParsed.success) {
    throw new HttpError(400, listParsed.error.errors[0]?.message || 'Invalid query', 'validation_failed');
  }
  const lq = listParsed.data;
  if (lq.novelId) await requireNovel(lq.novelId, user.id);

  const active = lq.active === 'true' || lq.active === '1';
  const rows = listGenerations(user.id, {
    active,
    novelId: lq.novelId,
    chapterId: lq.chapterId,
    limit: lq.limit ?? 25,
  });
  const activeRows = active
    ? rows
    : listGenerations(user.id, { active: true, novelId: lq.novelId, limit: 100 });

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
