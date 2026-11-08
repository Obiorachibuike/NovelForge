import 'server-only';
import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import {
  GenerationEventType,
  type GenerationJobRow,
} from '@/lib/jobs/job-types';
import { publishGenerationEvent, safePublishGenerationEvent } from '@/lib/jobs/events';
import type {
  GenerationRequest,
  GenerationResultMeta,
} from './generation-types';
import { parseGenerationType } from './generation-types';

/**
 * Durable persistence for universal generations.
 *
 * Responsibilities (and nothing else):
 *  - the single row-insert used by the queue when a job is created;
 *  - durable chunk persistence (incremental text + monotonic sequence numbers);
 *  - the single, idempotent job *finalisation* primitives used by the worker.
 *
 * Finalisation deliberately lives here and is called by the worker only, so the
 * service and the worker cannot both finalise the same job. Every terminal
 * UPDATE is guarded on `status='processing'`, which makes it idempotent and
 * means a cancelled/finished job can never be overwritten by a later update.
 */

/** Marks a persisted job as owned by the universal engine. */
export const UNIVERSAL_ENGINE = 'universal';

export interface InsertGenerationJobInput {
  id?: string;
  userId: string;
  novelId: string;
  chapterId?: string | null;
  taskType: string;
  payload: Record<string, unknown>;
  status?: string;
  maxAttempts?: number;
  idempotencyKey?: string | null;
  scheduledAt?: string | null;
  priority?: number;
  provider?: string | null;
  model?: string | null;
}

/**
 * Inserts one durable generation row. The queue is the only caller: creation,
 * deduplication and dispatch must stay in one place.
 */
export function insertGenerationJobRow(input: InsertGenerationJobInput): string {
  const db = getDb();
  const now = new Date().toISOString();
  const id = input.id ?? nanoid();

  db.prepare(
    `INSERT INTO generation_jobs (
       id, userId, novelId, chapterId, taskType, payload, status, attempts, maxAttempts,
       idempotencyKey, createdAt, updatedAt, scheduledAt, progress, retryable, priority,
       provider, requestedModel
     )
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.userId,
    input.novelId,
    input.chapterId ?? null,
    input.taskType,
    JSON.stringify(input.payload ?? {}),
    input.status ?? 'queued',
    0,
    input.maxAttempts ?? 3,
    input.idempotencyKey ?? null,
    now,
    now,
    input.scheduledAt ?? now,
    0,
    1,
    input.priority ?? 0,
    input.provider ?? null,
    input.model ?? null,
  );

  return id;
}

/** Parses a persisted payload defensively (a corrupt row must not crash a worker). */
export function parseJobPayload(payload: string | null | undefined): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * True when the persisted row was created by the universal engine.
 *
 * The discriminator is written into the job payload at creation time, so it is
 * durable, survives restarts and is available to the worker and the SSE route
 * without a handler lookup. Legacy jobs (created by the existing services) never
 * carry it, so they can never be misrouted into the universal engine.
 */
export function isUniversalEngineJob(job: Pick<GenerationJobRow, 'payload'> | null | undefined): boolean {
  if (!job) return false;
  return parseJobPayload(job.payload).engine === UNIVERSAL_ENGINE;
}

/** Rebuilds the validated request an engine needs from a persisted job row. */
export function generationRequestFromJobRow(job: GenerationJobRow): GenerationRequest {
  const payload = parseJobPayload(job.payload);
  const generationType = parseGenerationType(job.taskType) ?? 'custom';
  const prompt = typeof payload.prompt === 'string' && payload.prompt.length > 0
    ? payload.prompt
    : `Generate the requested ${job.taskType.replace(/_/g, ' ')} for this project.`;

  const provider = payload.provider;
  return {
    projectId: job.novelId,
    userId: job.userId,
    generationType,
    ...(typeof payload.customType === 'string' ? { customType: payload.customType } : {}),
    ...(typeof payload.targetType === 'string' ? { targetType: payload.targetType } : {}),
    ...(job.chapterId ? { targetId: job.chapterId } : {}),
    prompt,
    context:
      payload.context && typeof payload.context === 'object' && !Array.isArray(payload.context)
        ? (payload.context as Record<string, unknown>)
        : {},
    ...(typeof provider === 'string' ? { provider: provider as GenerationRequest['provider'] } : {}),
    ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
    stream: payload.stream === true,
    metadata:
      payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : {},
    ...(job.idempotencyKey ? { idempotencyKey: job.idempotencyKey } : {}),
  };
}

// ─── Chunk persistence ───────────────────────────────────────────────────────

export interface ChunkSink {
  readonly jobId: string;
  readonly text: string;
  readonly sequence: number;
  /** Persists one delta and publishes a durable content event. Returns the sequence. */
  append(delta: string): number;
}

/**
 * Opens a durable chunk sink for one job.
 *
 * - every chunk is appended to `generation_jobs.result.partialText`, so the
 *   accumulated prose survives a process restart (it is not kept in memory);
 * - every chunk is also a `generation_events` row, which is what the SSE route
 *   replays after a reconnect;
 * - sequence numbers are monotonic per job and continue across a worker
 *   restart (they resume from the job's highest persisted event sequence).
 */
export function openChunkSink(jobId: string): ChunkSink {
  const db = getDb();
  const job = db
    .prepare('SELECT id,userId,novelId,chapterId,result FROM generation_jobs WHERE id=?')
    .get(jobId) as Pick<GenerationJobRow, 'id' | 'userId' | 'novelId' | 'chapterId' | 'result'> | undefined;

  let text = '';
  if (job?.result) {
    try {
      const parsed = JSON.parse(job.result);
      if (typeof parsed?.partialText === 'string') text = parsed.partialText;
    } catch {
      /* a malformed partial result must not block a fresh stream */
    }
  }

  const maxSeq = Number(
    (
      db.prepare('SELECT COALESCE(MAX(seq),0) AS maxSeq FROM generation_events WHERE jobId=?').get(jobId) as {
        maxSeq: number;
      }
    ).maxSeq ?? 0,
  );

  let sequence = maxSeq;

  return {
    jobId,
    get text() {
      return text;
    },
    get sequence() {
      return sequence;
    },
    append(delta: string) {
      if (!delta) return sequence;
      sequence += 1;
      text += delta;
      const now = new Date().toISOString();

      // The accumulated text is written on every chunk: the row is the durable
      // copy, the event below is the replayable one.
      try {
        db.prepare(
          `UPDATE generation_jobs
              SET result=?, updatedAt=?, lastHeartbeatAt=?
            WHERE id=? AND status='processing'`,
        ).run(JSON.stringify({ partialText: text }), now, now, jobId);
      } catch (err) {
        console.error('[generation-persistence] could not persist chunk text', jobId, err);
      }

      safePublishGenerationEvent({
        jobId,
        userId: job?.userId ?? '',
        novelId: job?.novelId ?? null,
        chapterId: job?.chapterId ?? null,
        type: GenerationEventType.CONTENT,
        status: 'PROCESSING',
        data: {
          sequence,
          content: delta,
          delta,
          totalLength: text.length,
        },
      });

      return sequence;
    },
  };
}

/**
 * Persists provider provenance for a job (requested vs actual model/provider).
 * Never changes the job status, so it can never race a finalisation.
 */
export function recordGenerationProvenance(jobId: string, meta: GenerationResultMeta): void {
  if (!meta) return;
  try {
    getDb()
      .prepare(
        `UPDATE generation_jobs
            SET provider=?, requestedModel=COALESCE(requestedModel, ?), actualModel=?,
                fallbackCount=?, durationMs=?, updatedAt=?
          WHERE id=? AND status='processing'`,
      )
      .run(
        meta.provider ?? meta.source,
        meta.model ?? null,
        meta.actualModel ?? meta.model ?? null,
        meta.usedFallback ? 1 : 0,
        typeof meta.latencyMs === 'number' ? Math.round(meta.latencyMs) : null,
        new Date().toISOString(),
        jobId,
      );
  } catch (err) {
    console.error('[generation-persistence] could not record provenance', jobId, err);
  }
}

// ─── Finalisation primitives (worker-owned) ─────────────────────────────────

export interface CompleteGenerationInput {
  result: unknown;
  /** `awaiting_review` is used by handlers that produce a draft. */
  status?: 'completed' | 'awaiting_review';
  chapterId?: string | null;
  /**
   * Chapter generation is stage-based and has no real percentage, so its
   * `progressPercentage` stays NULL instead of fabricating one.
   */
  indeterminate?: boolean;
}

/**
 * Marks a claimed job as completed. Returns false when the job is no longer
 * `processing` (cancelled, or already finalised by a previous attempt), which
 * is what makes finalisation idempotent.
 */
export function completeGenerationJob(jobId: string, input: CompleteGenerationInput): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const status = input.status ?? 'completed';

  // Text results are also exposed as `partialText`, which is what
  // `serializeGeneration()` and therefore the API/SSE snapshot read.
  let serialized: string | null = null;
  if (input.result !== undefined && input.result !== null) {
    const value = input.result as Record<string, unknown>;
    if (
      typeof value === 'object' &&
      typeof value.text === 'string' &&
      typeof value.partialText !== 'string'
    ) {
      serialized = JSON.stringify({ ...value, partialText: value.text });
    } else {
      serialized = JSON.stringify(input.result);
    }
  }


  const res = db
    .prepare(
      `UPDATE generation_jobs
          SET status=?, result=?, error=NULL, errorCode=NULL, completedAt=?, updatedAt=?,
              claimedAt=NULL, claimedBy=NULL, progress=100, progressPercentage=?,
              currentStage=?, stageUpdatedAt=?, lastHeartbeatAt=?
        WHERE id=? AND status='processing'`,
    )
    .run(
      status,
      serialized,
      now,
      now,
      input.indeterminate ? null : 100,
      'COMPLETED',
      now,
      now,
      jobId,
    );

  if (res.changes === 0) return false;

  if (input.chapterId) {
    try {
      db.prepare('UPDATE generation_jobs SET chapterId=? WHERE id=?').run(input.chapterId, jobId);
    } catch (err) {
      console.error('[generation-persistence] could not record chapterId', jobId, err);
    }
  }
  return true;
}

/** Marks a claimed job as failed. Idempotent; never revives a cancelled job. */
export function failGenerationJob(
  jobId: string,
  input: { message: string; code?: string | null; retryable?: boolean },
): boolean {
  const now = new Date().toISOString();
  const res = getDb()
    .prepare(
      `UPDATE generation_jobs
          SET status='failed', error=?, errorCode=?, retryable=?, completedAt=?, updatedAt=?,
              claimedAt=NULL, claimedBy=NULL, progressPercentage=NULL
        WHERE id=? AND status='processing'`,
    )
    .run(
      input.message,
      input.code ?? null,
      input.retryable === false ? 0 : 1,
      now,
      now,
      jobId,
    );
  return res.changes > 0;
}

/** Returns a failed/abandoned attempt to the queue with a backoff. */
export function requeueGenerationJob(
  jobId: string,
  input: { message: string; code?: string | null; delayMs: number },
): boolean {
  const now = new Date().toISOString();
  const res = getDb()
    .prepare(
      `UPDATE generation_jobs
          SET status='queued', error=?, errorCode=?, retryable=1, scheduledAt=?, updatedAt=?,
              claimedAt=NULL, claimedBy=NULL, progressPercentage=NULL, currentStage=NULL
        WHERE id=? AND status='processing'`,
    )
    .run(
      input.message,
      input.code ?? null,
      new Date(Date.now() + Math.max(0, input.delayMs)).toISOString(),
      now,
      jobId,
    );
  return res.changes > 0;
}

/**
 * Publishes the terminal event for a job. Kept next to the finalisation
 * primitives so a caller that finalises also announces it exactly once.
 */
export function publishTerminalEvent(
  job: Pick<GenerationJobRow, 'id' | 'userId' | 'novelId' | 'chapterId'>,
  outcome: 'completed' | 'failed' | 'cancelled',
  data: Record<string, unknown>,
): void {
  const type =
    outcome === 'completed'
      ? GenerationEventType.COMPLETED
      : outcome === 'failed'
        ? GenerationEventType.FAILED
        : GenerationEventType.CANCELLED;
  safePublishGenerationEvent({
    jobId: job.id,
    userId: job.userId,
    novelId: job.novelId ?? null,
    chapterId: job.chapterId ?? null,
    type,
    status: outcome.toUpperCase(),
    data,
  });
}

/** Persists one progress/content event outside the chunk stream. */
export function publishProgressEvent(
  job: Pick<GenerationJobRow, 'id' | 'userId' | 'novelId' | 'chapterId'>,
  stage: string,
  data: Record<string, unknown> = {},
): void {
  publishGenerationEvent({
    jobId: job.id,
    userId: job.userId,
    novelId: job.novelId ?? null,
    chapterId: job.chapterId ?? null,
    type: GenerationEventType.PROGRESS,
    status: 'PROCESSING',
    stage,
    data,
  });
}
