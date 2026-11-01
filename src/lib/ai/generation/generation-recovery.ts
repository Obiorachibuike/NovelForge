import 'server-only';
import { getDb } from '@/lib/db';
import { GenerationEventType, GenerationStatus } from '@/lib/jobs/job-types';
import { safePublishGenerationEvent } from '@/lib/jobs/events';
import { classifyJobError } from '@/lib/queue';
import { GenerationRequest } from './generation-types';

/**
 * Recovers interrupted jobs during worker startup.
 * Detects jobs stuck in 'processing' without recent heartbeat.
 */
export function recoverStaleJobs(thresholdMs = 5 * 60_000) {
  const db = getDb();
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();

  const stale = db.prepare(
    `SELECT id, userId, novelId, chapterId, taskType, attempts
       FROM generation_jobs
       WHERE status = 'processing'
         AND (COALESCE(lastHeartbeatAt, claimedAt) IS NULL OR COALESCE(lastHeartbeatAt, claimedAt) < ?)`
  ).all(cutoff) as Array<{
    id: string;
    userId: string;
    novelId: string;
    chapterId: string | null;
    taskType: string;
    attempts: number;
  }>;

  const now = new Date().toISOString();
  for (const job of stale) {
    db.prepare(
      `UPDATE generation_jobs
         SET status = 'queued',
             claimedAt = NULL,
             claimedBy = NULL,
             scheduledAt = ?,
             updatedAt = ?,
             error = COALESCE(error, 'Recovered from interrupted worker'),
             currentStage = NULL,
             progressPercentage = NULL
       WHERE id = ? AND status = 'processing'`
    ).run(now, now, job.id);

    safePublishGenerationEvent({
      jobId: job.id,
      userId: job.userId,
      novelId: job.novelId,
      chapterId: job.chapterId,
      type: GenerationEventType.QUEUED,
      status: 'QUEUED',
      data: { recovered: true },
    });
  }

  return stale.length;
}
