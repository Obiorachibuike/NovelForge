import 'server-only';
import { getDb } from '@/lib/db';
import type { GenerationResult } from './generation-types';
import {
  GenerationEventType,
  GenerationStatus,
  type GenerationStage,
} from '@/lib/jobs/job-types';
import { safePublishGenerationEvent } from '@/lib/jobs/events';

/**
 * Durable writes for the universal generation engine.
 *
 * Job *creation* is not part of this module: a universal job is a row in
 * `generation_jobs` like any other, so it is inserted and dispatched by
 * `enqueue()` in `@/lib/queue` (see `UniversalGenerationService.createJob`).
 * What lives here is the write path an executing job needs — streamed chunk
 * bookkeeping, finalization and cancellation — always against the real job row
 * so events carry the owning user and novel.
 */

interface JobOwnership {
  userId: string;
  novelId: string;
  chapterId: string | null;
  currentStage: string | null;
}

/**
 * Reads the ownership columns for a job so published events are attributed to
 * the right user/novel. A missing row yields empty ownership rather than
 * throwing: event writes are best-effort and must never fail a generation.
 */
function jobOwnership(jobId: string): JobOwnership {
  try {
    const row = getDb()
      .prepare('SELECT userId, novelId, chapterId, currentStage FROM generation_jobs WHERE id=?')
      .get(jobId) as
      | { userId: string; novelId: string; chapterId: string | null; currentStage: string | null }
      | undefined;
    return {
      userId: row?.userId ?? '',
      novelId: row?.novelId ?? '',
      chapterId: row?.chapterId ?? null,
      currentStage: row?.currentStage ?? null,
    };
  } catch (err) {
    console.error('[generation-persistence] could not read job ownership', jobId, err);
    return { userId: '', novelId: '', chapterId: null, currentStage: null };
  }
}

/**
 * Records one streamed chunk against the durable job row.
 *
 * The row update doubles as a heartbeat: a long stream that keeps producing
 * text must not look stale to the recovery sweep. The chunk is published as a
 * `generation_progress` event (the only incremental event type the SSE stream
 * and client hook understand) carrying the job's current stage, so the UI keeps
 * showing the stage it was already showing.
 */
export function persistChunk(jobId: string, sequence: number, content: string, isComplete = false) {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.prepare(
      `UPDATE generation_jobs
         SET progress = progress + 1,
             lastHeartbeatAt = ?,
             updatedAt = ?
       WHERE id = ? AND status = 'processing'`
    ).run(now, now, jobId);
  } catch (err) {
    // A missing row (or a job cancelled mid-stream) must not break the caller:
    // the provider stream is aborted through `isCancelled()` instead.
    console.error('[generation-persistence] could not record chunk', jobId, err);
  }

  const owner = jobOwnership(jobId);
  safePublishGenerationEvent({
    jobId,
    userId: owner.userId,
    novelId: owner.novelId,
    chapterId: owner.chapterId,
    type: isComplete ? GenerationEventType.COMPLETED : GenerationEventType.PROGRESS,
    status: isComplete ? GenerationStatus.COMPLETED : GenerationStatus.PROCESSING,
    stage: owner.currentStage,
    data: {
      sequence,
      content,
      isComplete,
      ...(owner.currentStage ? { stage: owner.currentStage } : {}),
    },
  });
}

/**
 * Finalizes job status and result.
 */
export function finalizeJob(
  jobId: string,
  status: 'completed' | 'failed',
  result?: GenerationResult,
  error?: string,
) {
  const db = getDb();
  const now = new Date().toISOString();
  const meta = result?.meta;

  const update = db.prepare(
    `UPDATE generation_jobs
       SET status = ?,
           result = ?,
           error = ?,
           completedAt = ?,
           updatedAt = ?,
           lastHeartbeatAt = ?,
           progressPercentage = ?,
           currentStage = ?,
           stageUpdatedAt = ?,
           claimedAt = NULL,
           claimedBy = NULL,
           provider = COALESCE(?, provider),
           requestedModel = COALESCE(?, requestedModel),
           actualModel = COALESCE(?, actualModel),
           durationMs = COALESCE(?, durationMs)
     WHERE id = ? AND status IN ('queued', 'processing', 'awaiting_review')`
  );

  const res = update.run(
    status,
    result ? JSON.stringify(result) : null,
    error || null,
    now,
    now,
    now,
    status === 'completed' ? 100 : null,
    status === 'completed' ? 'COMPLETED' : null,
    now,
    meta?.provider || meta?.source || null,
    meta?.model || null,
    meta?.actualModel || meta?.model || null,
    typeof meta?.latencyMs === 'number' ? Math.round(meta.latencyMs) : null,
    jobId
  );

  // A cancelled job stays cancelled and gets no terminal event of its own:
  // `cancelJob` already published `generation_cancelled`.
  if (res.changes === 0) return;

  // Emit terminal event
  const owner = jobOwnership(jobId);
  const type = status === 'completed' ? GenerationEventType.COMPLETED : GenerationEventType.FAILED;
  safePublishGenerationEvent({
    jobId,
    userId: owner.userId,
    novelId: owner.novelId,
    chapterId: owner.chapterId,
    type,
    status: status === 'completed' ? GenerationStatus.COMPLETED : GenerationStatus.FAILED,
    stage: status === 'completed' ? ('COMPLETED' as GenerationStage) : null,
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
           claimedBy = NULL,
           cancelRequestedAt = ?,
           progressPercentage = NULL
     WHERE id = ? AND status IN ('queued', 'processing', 'awaiting_review')`
  ).run(reason || 'Cancelled by user', now, now, now, jobId);

  if (res.changes > 0) {
    const owner = jobOwnership(jobId);
    safePublishGenerationEvent({
      jobId,
      userId: owner.userId,
      novelId: owner.novelId,
      chapterId: owner.chapterId,
      type: GenerationEventType.CANCELLED,
      status: GenerationStatus.CANCELLED,
      data: { reason: reason || null },
    });
  }
  return res.changes > 0;
}
