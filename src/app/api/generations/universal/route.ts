import 'server-only';
import { z } from 'zod';
import { apiHandler, readJsonBody, HttpError } from '@/lib/api/http';
import { requireUser, requireNovel } from '@/lib/db/ownership';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { assertRegisteredModelOrAgnes } from '@/lib/ai/model-selection';

import {
  GenerationRegistry,
  GenerationRequest,
  GenerationRequestSchema,
} from '@/lib/ai/generation/generation-types';
import { UniversalGenerationService } from '@/lib/ai/generation/generation-service';
import { serializeJob } from '@/lib/queue';
import { getGenerationForUser, serializeGeneration } from '@/lib/jobs/generation-jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/generations (Universal)
 *
 * Replaces specific route handlers for text/image/structure generation.
 * Validates request, creates universal job, and queues it.
 */
export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  enforceRateLimit('aiGeneration', user.id);
  enforceAiRateLimit('text', user.id);

  const body = await readJsonBody(req, v => GenerationRequestSchema.parse(v));
  
  // Project ownership check (novelId is projectId)
  if (body.projectId) {
    await requireNovel(body.projectId, user.id);
  }

  // Create Universal Job
  const jobId = await UniversalGenerationService.createJob({
    ...body,
    userId: user.id,
    projectId: body.projectId,
    targetId: body.targetId,
    generationType: body.generationType,
    prompt: body.prompt,
    context: body.context,
    provider: body.provider,
    model: body.model,
    stream: body.stream ?? false,
    metadata: body.metadata,
    idempotencyKey: body.idempotencyKey,
  });

  // Fetch serialized job for response
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
});

/**
 * GET /api/generations (Universal)
 *
 * Lists user's generations (all types).
 */
export const GET = apiHandler(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  
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

  // Use existing listGenerations or universal query
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
});
