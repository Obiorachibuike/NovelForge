import 'server-only';
import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import { GenerationRequest, GenerationChunk, GenerationResult } from './generation-types';
import { GenerationEventType, GenerationStatus } from '@/lib/jobs/job-types';
import { safePublishGenerationEvent } from '@/lib/jobs/events';
import { classifyJobError } from '@/lib/queue';
import { serializeGeneration } from '@/lib/jobs/generation-jobs';

/**
 * Persists a generation job row.
 */
export function createGenerationJob(req: GenerationRequest): string {
  const db = getDb();
  const now = new Date().toISOString();
  const id = nanoid();

  db.prepare(
    `INSERT INTO generation_jobs (
       id, userId, novelId, chapterId, taskType, payload, status, attempts, maxAttempts,
       idempotencyKey, createdAt, updatedAt, scheduledAt, progress, retryable, priority,
       provider, model, partialContent
     )
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    req.userId,
    req.projectId,
    req.targetId || null,
    req.generationType,
    JSON.stringify({
      prompt: req.prompt,
      context: req.context,
      targetType: req.targetType,
      ...(req.metadata || {}),
    }),
    'queued',
    0,
    3,
    req.idempotencyKey || null,
    now,
    now,
    null,
    0,
    1,
    0,
    req.provider || null,
    req.model || null,
    null
  );

  // Emit queued event
  safePublishGenerationEvent({
    jobId: id,
    userId: req.userId,
    novelId: req.projectId,
    chapterId: req.targetId ?? null,
    type: GenerationEventType.QUEUED,
    status: 'QUEUED',
    data: {
      generationType: req.generationType,
      stream: req.stream,
    },
  });

  return id;
}

/**
 * Persists incremental text chunks.
 */
export function persistChunk(jobId: string, sequence: number, content: string, isComplete = false) {
  const db = getDb();
  const now = new Date().toISOString();

  // Update partial content (append strategy for large outputs)
  db.prepare(
    `UPDATE generation_jobs
       SET partialContent = COALESCE(partialContent, '') || ?,
           updatedAt = ?,
           progress = progress + 1
     WHERE id = ?`
  ).run(content, now, jobId);

  // Persist event
  safePublishGenerationEvent({
    jobId,
    userId: '', // Will be filled in event service or passed in
    novelId: '',
    chapterId: null,
    type: isComplete ? GenerationEventType.COMPLETED : GenerationEventType.CONTENT,
    status: isComplete ? 'COMPLETED' : 'PROCESSING',
    data: {
      sequence,
      content,
      isComplete,
    },
  });
}

/**
 * Finalizes job status and result.
 */
export function finalizeJob(jobId: string, status: 'completed' | 'failed', result?: GenerationResult, error?: string) {
  const db = getDb();
  const now = new Date().toISOString();

  const update = db.prepare(
    `UPDATE generation_jobs
       SET status = ?,
           result = ?,
           error = ?,
           completedAt = ?,
           updatedAt = ?,
           progressPercentage = ?,
           currentStage = ?,
           stageUpdatedAt = ?
     WHERE id = ?`
  );

  update.run(
    status,
    result ? JSON.stringify(result) : null,
    error || null,
    now,
    now,
    status === 'completed' ? 100 : null,
    status === 'completed' ? 'COMPLETED' : null,
    now,
    jobId
  );

  // Emit terminal event
  const type = status === 'completed' ? GenerationEventType.COMPLETED : GenerationEventType.FAILED;
  safePublishGenerationEvent({
    jobId,
    userId: '', // Injected from job row in real service
    novelId: '',
    chapterId: null,
    type,
    status: status.toUpperCase() as 'COMPLETED' | 'FAILED',
    data: {
      result,
      error,
    },
  });
}

/**
 * Cancels job.
 */
export function cancelJob(jobId: string, reason?: string) {
  const db = getDb();
  const now = new Date().toISOString();

  const res = db.prepare(
    `UPDATE generation_jobs
       SET status = 'cancelled',
           error = ?,
           completedAt = ?,
           updatedAt = ?,
           claimedAt = NULL,
           claimedBy = NULL
     WHERE id = ? AND status IN ('queued', 'processing')`
  ).run(reason || 'Cancelled by user', now, now, jobId);

  if (res.changes > 0) {
    safePublishGenerationEvent({
      jobId,
      userId: '',
      novelId: '',
      chapterId: null,
      type: GenerationEventType.CANCELLED,
      status: 'CANCELLED',
      data: { reason },
    });
  }
  return res.changes > 0;
}
