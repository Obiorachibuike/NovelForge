import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import type { GenerationTask } from '@/types';
import {
  GenerationEventType,
  GenerationStage,
  toPublicStatus,
  stageLabel,
  type GenerationJobRow,
} from '@/lib/jobs/job-types';
import {
  queueTransport,
  CHAPTER_GENERATION_QUEUE,
  chapterQueueInfo,
  workerConcurrency,
  type QueueTransport,
} from '@/lib/jobs/queues';
import { safePublishGenerationEvent } from '@/lib/jobs/events';
import { safeNotifyGenerationEvent } from '@/lib/jobs/notifications';
import { sendChapterGeneration } from '@/lib/jobs/boss';
import 'server-only';

// --- UNIVERSAL GENERATION ENGINE ---
// The queue owns creation, claiming, retries and *finalisation* for every task
// type. Jobs created by the universal engine are marked in their persisted
// payload and executed through `UniversalGenerationService.executeJob`; every
// other job keeps using its registered legacy handler. Exactly one code path
// finalises a job, so the two engines can never fight over a row.
import { UniversalGenerationService } from '@/lib/ai/generation/generation-service';
import {
  completeGenerationJob,
  failGenerationJob,
  generationRequestFromJobRow,
  insertGenerationJobRow,
  isUniversalEngineJob,
  requeueGenerationJob,
} from '@/lib/ai/generation/generation-persistence';

/**
 * Durable job queue.
 *
 * Every job is a row in `generation_jobs`, and that row is the source of truth.
 * pg-boss (PostgreSQL) delivers a wake-up containing only the job id; the
 * worker claims the row with a compare-and-set UPDATE before running it. This
 * means:
 *
 *  - a lost or duplicated pg-boss message can never execute a generation twice;
 *  - a pg-boss outage can never lose work (the database sweep re-queues it);
 *  - progress, retries and history survive process/browser restarts.
 *
 * SQLite development/test runs use the same row-based queue without pg-boss.
 */

export type JobStatus = 'queued' | 'processing' | 'awaiting_review' | 'completed' | 'failed' | 'cancelled';

export class NonRetryableJobError extends Error {
  readonly retryable = false;
  readonly code: string;
  constructor(message: string, code = 'permanent_failure') {
    super(message);
    this.name = 'NonRetryableJobError';
    this.code = code;
  }
}

/**
 * Redacts API keys, bearer tokens and connection credentials so secrets can
 * never leak into persisted job rows, API responses or logs.
 */
export function sanitizeErrorMessage(raw: string): string {
  if (!raw) return 'Unknown error';
  return raw
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(redis|postgres|postgresql|mysql|https?):\/\/([^:\s/@]+):([^@\s/]+)@/gi, '$1://$2:[REDACTED]@');
}

const PERMANENT_ERROR_PATTERNS = [
  /no handler registered/i,
  /novel not found/i,
  /no outline for chapter/i,
  /chapter is already approved/i,
  /previous chapter must be approved/i,
  /chapter has author edits/i,
  /job was cancelled/i,
  /generation was cancelled/i,
  /chapter was approved while generation/i,
  /chapter was edited while generation/i,
  /daily ai token limit/i,
  /monthly ai budget/i,
  /invalid api key/i,
  /incorrect api key/i,
];

export function classifyJobError(err: unknown): { message: string; retryable: boolean; code: string } {
  const rawMessage = err instanceof Error ? err.message : String(err || 'Unknown error');
  const message = sanitizeErrorMessage(rawMessage);
  const anyErr = err as any;

  if (anyErr?.retryable === false || err instanceof NonRetryableJobError) {
    return { message, retryable: false, code: anyErr?.code || 'permanent_failure' };
  }
  if (
    anyErr?.code === 'ai_budget_exhausted' ||
    anyErr?.code === 'ai_daily_token_limit' ||
    anyErr?.code === 'ai_monthly_cost_limit' ||
    anyErr?.code === 'ai_max_completion_tokens'
  ) {
    return { message, retryable: false, code: anyErr.code };
  }
  const status = typeof anyErr?.status === 'number' ? anyErr.status : undefined;
  if (status && [400, 401, 402, 403, 404, 409, 413, 422].includes(status)) {
    return { message, retryable: false, code: anyErr?.code || `http_${status}` };
  }
  if (PERMANENT_ERROR_PATTERNS.some(rx => rx.test(message))) {
    return { message, retryable: false, code: anyErr?.code || 'domain_precondition_failed' };
  }
  return {
    message,
    retryable: true,
    code: anyErr?.code || (status === 429 ? 'rate_limited' : 'transient_error'),
  };
}

export interface JobRecord extends GenerationJobRow {
  taskType: string;
}

export interface JobHandlerContext {
  id: string;
  payload: Record<string, unknown>;
  novelId: string;
  userId: string;
  chapterId?: string | null;
  /**
   * Persists a real generation stage and publishes `generation_progress`.
   * The UI only ever shows stages actually reached by the worker.
   */
  setStage: (stage: GenerationStage | string, data?: Record<string, unknown>) => void;
  /**
   * Legacy numeric progress for non-chapter jobs. Chapter generation does not
   * fabricate percentages (see `progressPercentage` staying NULL).
   */
  setProgress: (percent: number) => void;
  /** True if the job was cancelled while running. */
  isCancelled: () => boolean;
  /** Aborted as soon as the job is cancelled, so provider calls can stop. */
  signal: AbortSignal;
}

type JobHandler = (job: JobHandlerContext) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();

export function registerHandler(taskType: string, handler: JobHandler) {
  handlers.set(taskType, handler);
}

export function hasHandler(taskType: string): boolean {
  return handlers.has(taskType);
}

/** The active queue transport. `pgboss` in PostgreSQL deployments. */
export function queueDriver(): QueueTransport {
  return queueTransport();
}

export function queueInfo() {
  const transport = queueTransport();
  return {
    driver: transport,
    transport,
    pgBoss: transport === 'pgboss',
    /** Kept for API consumers that predate pg-boss; Redis is never used. */
    redisConfigured: false,
    queue: CHAPTER_GENERATION_QUEUE,
    concurrency: workerConcurrency(),
    note: chapterQueueInfo().note,
  };
}

function nowIso() { return new Date().toISOString(); }

function envInt(name: string, fallback: number) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** True when this process may optimistically run a queued job itself. */
function mayRunInProcess(): boolean {
  if (process.env.QUEUE_NO_INPROCESS) return false;
  // Never inside the Next.js production runtime: generation must survive an
  // application restart, so a dedicated worker owns execution there.
  if (process.env.NODE_ENV === 'production') return false;
  return queueTransport() === 'database';
}

function updateChapterGenerationStatus(
  chapterId: string | null | undefined,
  status: string,
  options: { clearStage?: boolean } = {},
) {
  if (!chapterId) return;
  try {
    getDb()
      .prepare('UPDATE chapters SET generationStatus=?, updatedAt=? WHERE id=?')
      .run(status, nowIso(), chapterId);
  } catch (err) {
    // A chapter can legitimately disappear between queueing and execution.
    console.warn('[queue] could not update chapter generation status', chapterId, err);
  }
}

function emitLifecycle(
  job: Pick<JobRecord, 'id' | 'userId' | 'novelId' | 'chapterId' | 'taskType' | 'attempts'>,
  type: string,
  extra: {
    stage?: string | null;
    message?: string | null;
    data?: Record<string, unknown>;
    notify?: boolean;
  } = {},
) {
  safePublishGenerationEvent({
    jobId: job.id,
    userId: job.userId,
    novelId: job.novelId,
    chapterId: job.chapterId ?? null,
    type,
    status: type === GenerationEventType.QUEUED
      ? 'QUEUED'
      : type === GenerationEventType.STARTED
        ? 'PROCESSING'
        : type === GenerationEventType.COMPLETED
          ? 'COMPLETED'
          : type === GenerationEventType.FAILED
            ? 'FAILED'
            : type === GenerationEventType.CANCELLED
              ? 'CANCELLED'
              : 'PROCESSING',
    stage: extra.stage ?? null,
    data: {
      ...(extra.stage ? { stage: extra.stage, stageLabel: stageLabel(extra.stage) } : {}),
      ...(extra.message ? { message: extra.message } : {}),
      ...(extra.data ?? {}),
    },
  });
  if (extra.notify) {
    safeNotifyGenerationEvent(job as JobRecord, type, {
      stage: extra.stage ?? null,
      error: extra.message ?? null,
    });
  }
}

export interface EnqueueOptions extends GenerationTask {
  chapterId?: string | null;
  maxAttempts?: number;
  /** Milliseconds to wait before the job may first be claimed. */
  delayMs?: number;
  priority?: number;
}

export async function enqueue(task: EnqueueOptions): Promise<string> {
  const db = getDb();
  const now = nowIso();
  const id = nanoid();

  if (task.idempotencyKey) {
    const existing = db.prepare(
      `SELECT id FROM generation_jobs WHERE idempotencyKey = ? AND status IN ('queued','processing')`,
    ).get(task.idempotencyKey) as { id: string } | undefined;
    if (existing) return existing.id;
  }

  try {
    insertGenerationJobRow({
      id,
      userId: task.userId,
      novelId: task.novelId,
      chapterId: task.chapterId || null,
      taskType: task.type,
      payload: (task.payload ?? {}) as Record<string, unknown>,
      maxAttempts: task.maxAttempts ?? 3,
      idempotencyKey: task.idempotencyKey || null,
      scheduledAt: task.delayMs ? new Date(Date.now() + task.delayMs).toISOString() : now,
      priority: task.priority ?? 0,
      provider: typeof task.payload?.provider === 'string' ? (task.payload.provider as string) : null,
      model: typeof task.payload?.model === 'string' ? (task.payload.model as string) : null,
    });
  } catch (err) {
    // Partial unique index violation: another request enqueued the same work
    // between our SELECT and INSERT.
    if (task.idempotencyKey && /UNIQUE|duplicate key/i.test(String(err))) {
      const existing = db.prepare(
        `SELECT id FROM generation_jobs WHERE idempotencyKey = ? AND status IN ('queued','processing')`,
      ).get(task.idempotencyKey) as { id: string } | undefined;
      if (existing) return existing.id;
    }
    throw err;
  }

  const inserted = db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(id) as JobRecord;
  const universal = isUniversalEngineJob(inserted);
  if (task.type === 'chapter') {
    updateChapterGenerationStatus(task.chapterId, 'QUEUED');
  }
  if (task.type === 'chapter' || universal) {
    emitLifecycle(inserted, GenerationEventType.QUEUED, {
      data: {
        chapterNumber: (task.payload as any)?.chapterNumber ?? null,
        ...(universal ? { generationType: task.type } : {}),
      },
    });
  }

  await dispatch(id, { delayMs: task.delayMs, priority: task.priority });
  return id;
}

/** Wakes the pg-boss worker, or runs in-process in SQLite development/test. */
async function dispatch(id: string, options: { delayMs?: number; priority?: number } = {}) {
  const row = (await getJob(id)) as JobRecord | undefined;
  if (!row) return;

  // Background work NEVER runs inside the Next.js process when pg-boss is the
  // transport: not in a request, not in a setImmediate, and not on a serverless
  // host. The dedicated worker owns execution in every environment, and the
  // wake-up carries only the durable job id (any task type, not just chapters).
  // SQLite development has no pg-boss, so the worker's database sweep and the
  // optional in-process dispatch below cover it.
  if (queueTransport() === 'pgboss') {
    try {
      const queueJobId = await sendChapterGeneration(id, {
        priority: options.priority ?? row.priority ?? 0,
        delayMs: options.delayMs,
      });
      if (queueJobId) {
        getDb().prepare('UPDATE generation_jobs SET queueJobId=?, updatedAt=? WHERE id=?')
          .run(queueJobId, nowIso(), id);
      }
    } catch (err) {
      // Durable row remains queued; the worker's database sweep will run it.
      console.error('[queue] pg-boss send failed; job remains queued in PostgreSQL:', err);
    }
    return;
  }

  if (mayRunInProcess()) {
    if (options.delayMs && options.delayMs > 0) {
      setTimeout(() => { void runJob(id).catch(e => console.error('[queue] job failed', id, e)); }, options.delayMs);
    } else {
      setImmediate(() => { void runJob(id).catch(err => console.error('[queue] job failed', id, err)); });
    }
  }
}

export interface JobRunResult {
  id: string;
  status: JobStatus | 'skipped';
  reason?: string;
}

/**
 * Claims and executes a job.
 *
 * The claim is a single UPDATE ... WHERE status='queued' guarded by the
 * scheduler time; two racing callers cannot both proceed, which is what makes
 * "generate chapter N" safe against duplicate/burst requests and pg-boss
 * redelivery.
 */
/**
 * Wraps the universal engine as a queue handler for one job.
 *
 * The request is rebuilt from the persisted row (not from the caller's memory),
 * so a worker restart, a pg-boss redelivery and a database-sweep recovery all
 * execute exactly the same validated request, with the real job id.
 */
function makeUniversalJobHandler(job: JobRecord): JobHandler {
  return async ctx => {
    const request = generationRequestFromJobRow(job);
    return UniversalGenerationService.executeJob(job.id, request, {
      setStage: ctx.setStage,
      setProgress: ctx.setProgress,
      isCancelled: ctx.isCancelled,
      signal: ctx.signal,
    });
  };
}

export async function runJob(id: string, workerId = `${process.pid}`): Promise<JobRunResult> {
  const db = getDb();
  const now = nowIso();
  const claim = db.prepare(
    `UPDATE generation_jobs
        SET status='processing', attempts=attempts+1, claimedAt=?, claimedBy=?,
            startedAt=COALESCE(startedAt,?), updatedAt=?, progressPercentage=NULL,
            currentStage=?, stageUpdatedAt=?, lastHeartbeatAt=?
      WHERE id=?
        AND status='queued'
        AND (scheduledAt IS NULL OR scheduledAt <= ?)`,
  ).run(now, workerId, now, now, GenerationStage.STARTING, now, now, id, now);

  if (claim.changes === 0) {
    const row = db.prepare('SELECT status FROM generation_jobs WHERE id=?').get(id) as { status: JobStatus } | undefined;
    return { id, status: 'skipped', reason: row ? `not claimable (status=${row.status})` : 'missing' };
  }

  const job = db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(id) as JobRecord;

  // Routing is decided by the *persisted* job (payload marker), never by a
  // handler lookup: built-in generation types are served by the universal
  // engine even when no custom handler is registered, while legacy jobs keep
  // their existing services and are never rerouted.
  const universal = isUniversalEngineJob(job);
  const tracked = job.taskType === 'chapter';
  /** Whether a stage transition should also become a durable SSE event. */
  const publishesProgress = tracked || universal;

  const handler = universal ? makeUniversalJobHandler(job) : handlers.get(job.taskType);
  if (!handler) {
    const message = `No handler registered for task type ${job.taskType}`;
    failGenerationJob(id, { message, code: 'no_handler', retryable: false });
    if (tracked) {
      updateChapterGenerationStatus(job.chapterId, 'FAILED');
      emitLifecycle(job, GenerationEventType.FAILED, { message, notify: true });
    }
    return { id, status: 'failed', reason: 'no handler' };
  }

  // Cancellation is observed by polling the durable row; this also aborts the
  // in-flight provider request when the provider supports an AbortSignal.
  const controller = new AbortController();
  let cancelled = false;
  const cancelledError = () => Object.assign(new Error('Generation was cancelled.'), { retryable: false, code: 'cancelled' });
  const checkCancelled = () => {
    if (cancelled) return true;
    try {
      const row = db.prepare('SELECT status FROM generation_jobs WHERE id=?').get(id) as { status: JobStatus } | undefined;
      return !row || row.status === 'cancelled';
    } catch {
      return false;
    }
  };
  const cancelPoll = setInterval(() => {
    if (checkCancelled()) {
      cancelled = true;
      if (!controller.signal.aborted) controller.abort(cancelledError());
    }
  }, Math.max(500, envInt('GENERATION_CANCEL_POLL_MS', 1500)));
  if (typeof cancelPoll.unref === 'function') cancelPoll.unref();

  // A generation can legitimately take many minutes. Without a heartbeat the
  // stale-job recovery would mistake it for a dead worker and start a second
  // execution. The heartbeat is independent of provider output.
  const heartbeat = setInterval(() => {
    const stamp = nowIso();
    try {
      db.prepare(
        "UPDATE generation_jobs SET lastHeartbeatAt=?, updatedAt=? WHERE id=? AND status='processing'",
      ).run(stamp, stamp, id);
    } catch (err) {
      console.error('[queue] could not record heartbeat', id, err);
    }
  }, Math.max(5_000, envInt('GENERATION_HEARTBEAT_MS', 20_000)));
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const setStage = (stage: string, data?: Record<string, unknown>) => {
    const stamp = nowIso();
    try {
      db.prepare(
        `UPDATE generation_jobs
            SET currentStage=?, stageUpdatedAt=?, lastHeartbeatAt=?, updatedAt=?
          WHERE id=? AND status='processing'`,
      ).run(stage, stamp, stamp, stamp, id);
    } catch (err) {
      console.error('[queue] could not persist generation stage', stage, err);
    }
    if (publishesProgress) {
      safePublishGenerationEvent({
        jobId: job.id,
        userId: job.userId,
        novelId: job.novelId,
        chapterId: job.chapterId ?? null,
        type: GenerationEventType.PROGRESS,
        status: 'PROCESSING',
        stage,
        data: { stage, stageLabel: stageLabel(stage), ...(data ?? {}) },
      });
    }
  };

  const setProgress = (percent: number) => {
    // Chapter progress is stage-based and deliberately indeterminate.
    if (tracked) return;
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    db.prepare(`UPDATE generation_jobs SET progress=?, progressPercentage=?, updatedAt=? WHERE id=? AND status='processing'`)
      .run(value, value, nowIso(), id);
  };

  if (tracked) {
    updateChapterGenerationStatus(job.chapterId, 'PROCESSING');
    emitLifecycle(job, GenerationEventType.STARTED, {
      stage: GenerationStage.PREPARING_CHAPTER,
      notify: true,
    });
  } else if (universal) {
    emitLifecycle(job, GenerationEventType.STARTED, {
      stage: GenerationStage.STARTING,
      data: { generationType: job.taskType },
    });
  }

  try {
    const payload = job.payload ? JSON.parse(job.payload) : {};
    const result = await handler({
      id,
      payload,
      novelId: job.novelId,
      userId: job.userId,
      chapterId: job.chapterId ?? null,
      isCancelled: checkCancelled,
      signal: controller.signal,
      setStage,
      setProgress,
    });

    const awaitingReview = !!(result && typeof result === 'object' && (result as any).awaitingReview === true);
    const targetStatus: JobStatus = awaitingReview ? 'awaiting_review' : 'completed';
    const resultChapterId =
      (result && typeof result === 'object' && typeof (result as any).chapterId === 'string')
        ? (result as any).chapterId
        : null;

    // ONE finalisation owner: the worker, through the idempotent persistence
    // primitive. A job that was cancelled mid-flight is not resurrected.
    const finalized = completeGenerationJob(id, {
      result: result ?? null,
      status: awaitingReview ? 'awaiting_review' : 'completed',
      chapterId: resultChapterId,
      indeterminate: tracked,
    });
    if (!finalized) {
      return { id, status: 'cancelled', reason: 'cancelled while processing' };
    }

    if (tracked) {
      // The chapter row may have been created *by* the handler, in which case
      // the job row (and its chapterId) was updated during execution.
      const fresh = db.prepare('SELECT chapterId FROM generation_jobs WHERE id=?').get(id) as
        | { chapterId: string | null }
        | undefined;
      const completedJob = {
        ...job,
        chapterId: resultChapterId ?? fresh?.chapterId ?? job.chapterId ?? null,
      };
      updateChapterGenerationStatus(completedJob.chapterId, 'COMPLETED');
      emitLifecycle(completedJob, GenerationEventType.COMPLETED, {
        stage: GenerationStage.COMPLETED,
        notify: true,
        data: {
          chapterId: completedJob.chapterId,
          chapterNumber: (result as any)?.chapterNumber ?? (job.payload ? JSON.parse(job.payload).chapterNumber : null),
        },
      });
    } else if (universal) {
      emitLifecycle(job, GenerationEventType.COMPLETED, {
        stage: GenerationStage.COMPLETED,
        data: {
          generationType: job.taskType,
          ...(awaitingReview ? { awaitingReview: true } : {}),
          ...(result && typeof result === 'object' && (result as any).assets
            ? { assets: (result as any).assets }
            : {}),
        },
      });
    }

    return { id, status: targetStatus };
  } catch (err) {
    if (checkCancelled() || controller.signal.aborted) {
      db.prepare(`UPDATE generation_jobs SET claimedAt=NULL, claimedBy=NULL, updatedAt=? WHERE id=?`).run(nowIso(), id);
      return { id, status: 'cancelled', reason: 'cancelled' };
    }
    const classified = classifyJobError(err);
    const attempts = (db.prepare('SELECT attempts FROM generation_jobs WHERE id=?').get(id) as { attempts: number }).attempts;
    const maxAttempts = job.maxAttempts || 3;

    if (!classified.retryable || attempts >= maxAttempts) {
      const failed = failGenerationJob(id, {
        message: classified.message,
        code: classified.code,
        retryable: classified.retryable,
      });
      if (tracked) {
        updateChapterGenerationStatus(job.chapterId, 'FAILED');
        emitLifecycle(job, GenerationEventType.FAILED, {
          message: classified.message,
          notify: true,
          data: { errorCode: classified.code, retryable: classified.retryable },
        });
      } else if (universal && failed) {
        emitLifecycle(job, GenerationEventType.FAILED, {
          message: classified.message,
          data: {
            generationType: job.taskType,
            errorCode: classified.code,
            retryable: classified.retryable,
          },
        });
      }
      return { id, status: 'failed', reason: classified.message };
    }

    const backoffMs = Math.min(60_000, 2000 * 2 ** (attempts - 1));
    const requeued = requeueGenerationJob(id, {
      message: classified.message,
      code: classified.code,
      delayMs: backoffMs,
    });
    if (tracked) {
      updateChapterGenerationStatus(job.chapterId, 'QUEUED');
      emitLifecycle(job, GenerationEventType.QUEUED, {
        message: classified.message,
        data: { retryAt: new Date(Date.now() + backoffMs).toISOString(), attempt: attempts },
      });
    } else if (universal && requeued) {
      emitLifecycle(job, GenerationEventType.QUEUED, {
        message: classified.message,
        data: {
          generationType: job.taskType,
          retryAt: new Date(Date.now() + backoffMs).toISOString(),
          attempt: attempts,
        },
      });
    }
    await dispatch(id, { delayMs: backoffMs, priority: job.priority ?? 0 });
    return { id, status: 'queued', reason: classified.message };
  } finally {
    clearInterval(cancelPoll);
    clearInterval(heartbeat);
  }
}

/**
 * Requeues jobs abandoned by a dead worker and returns currently-due work.
 * Safe to call from every instance: the claim UPDATE makes double-processing
 * impossible even if two instances sweep simultaneously.
 */
export async function recoverStaleJobs({ limit = 20, staleMs }: { limit?: number; staleMs?: number } = {}) {
  const db = getDb();
  const threshold = staleMs ?? envInt('QUEUE_STALE_JOB_MS', 5 * 60_000);
  const cutoff = new Date(Date.now() - threshold).toISOString();

  const stale = db.prepare(
    `SELECT id,userId,novelId,chapterId,taskType,attempts FROM generation_jobs
      WHERE status='processing'
        AND (COALESCE(lastHeartbeatAt, claimedAt) IS NULL OR COALESCE(lastHeartbeatAt, claimedAt) < ?)`
  ).all(cutoff) as Pick<JobRecord, 'id' | 'userId' | 'novelId' | 'chapterId' | 'taskType' | 'attempts'>[];

  for (const job of stale) {
    db.prepare(
      `UPDATE generation_jobs
          SET status='queued', claimedAt=NULL, claimedBy=NULL, scheduledAt=?, updatedAt=?,
              error=COALESCE(error, 'Recovered from an interrupted worker'),
              currentStage=NULL, progressPercentage=NULL
        WHERE id=? AND status='processing'`
    ).run(nowIso(), nowIso(), job.id);
    if (job.taskType === 'chapter') {
      updateChapterGenerationStatus(job.chapterId, 'QUEUED');
    }
    if (job.taskType === 'chapter' || isUniversalEngineJob(job as JobRecord)) {
      emitLifecycle(job as JobRecord, GenerationEventType.QUEUED, {
        message: 'Worker restart detected — generation re-queued.',
        data: { recovered: true },
      });
    }
    // Every recovered job is re-announced to the transport (pg-boss wake-up in
    // production, in-process dispatch in development).
    await dispatch(job.id);
  }

  const due = db.prepare(
    `SELECT id FROM generation_jobs
      WHERE status='queued' AND (scheduledAt IS NULL OR scheduledAt <= ?)
      ORDER BY priority DESC, createdAt ASC LIMIT ?`
  ).all(nowIso(), limit) as { id: string }[];

  return { recovered: stale.length, due: due.map(d => d.id) };
}

/** Claims and runs up to `limit` due jobs (used by the worker loop and tests). */
export async function drainQueue({ limit = 5, workerId }: { limit?: number; workerId?: string } = {}) {
  const { due } = await recoverStaleJobs({ limit });
  const results: JobRunResult[] = [];
  for (const id of due) results.push(await runJob(id, workerId));
  return results;
}

export async function getJob(id: string) {
  const db = getDb();
  return db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id) as JobRecord | undefined;
}

export async function listJobs(novelId: string, { limit = 20 } = {}) {
  const db = getDb();
  return db.prepare('SELECT * FROM generation_jobs WHERE novelId = ? ORDER BY createdAt DESC LIMIT ?')
    .all(novelId, limit) as JobRecord[];
}

export async function listUserJobs(userId: string, { limit = 20 } = {}) {
  const db = getDb();
  return db.prepare('SELECT * FROM generation_jobs WHERE userId = ? ORDER BY createdAt DESC LIMIT ?')
    .all(userId, limit) as JobRecord[];
}

/** Counts active chapter generations; used to enforce per-user/novel limits. */
export function countActiveChapterJobs(filter: { userId?: string; novelId?: string; excludeChapterId?: string | null }) {
  const db = getDb();
  const clauses = [`taskType='chapter'`, `status IN ('queued','processing')`];
  const args: unknown[] = [];
  if (filter.userId) { clauses.push('userId=?'); args.push(filter.userId); }
  if (filter.novelId) { clauses.push('novelId=?'); args.push(filter.novelId); }
  if (filter.excludeChapterId) { clauses.push('(chapterId IS NULL OR chapterId != ?)'); args.push(filter.excludeChapterId); }
  const row = db.prepare(`SELECT COUNT(*) AS total FROM generation_jobs WHERE ${clauses.join(' AND ')}`)
    .get(...args) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

/**
 * Marks a queued or processing job as cancelled. Returns false when it has
 * already finished (completed, failed, or cancelled).
 *
 * Cancellation is cooperative: the worker observes the status (and aborts the
 * provider request). Existing chapter content is never touched.
 */
export function cancelJob(id: string): boolean {
  const db = getDb();
  const now = nowIso();
  const job = db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(id) as JobRecord | undefined;
  if (!job) return false;

  // ONE cancellation path for every task type. The durable row is the source of
  // truth: the worker polls it, aborts the provider request where supported and
  // refuses to write generated content afterwards.
  const res = db.prepare(
    `UPDATE generation_jobs
        SET status='cancelled', updatedAt=?, completedAt=COALESCE(completedAt, ?), claimedAt=NULL, claimedBy=NULL,
            cancelRequestedAt=?, progressPercentage=NULL
      WHERE id=? AND status IN ('queued','processing','awaiting_review')`
  ).run(now, now, now, id);
  if (res.changes === 0) return false;

  if (job.taskType === 'chapter') {
    updateChapterGenerationStatus(job.chapterId, 'CANCELLED');
    emitLifecycle(job, GenerationEventType.CANCELLED, {
      notify: true,
      message: 'Generation cancelled. Existing chapter content was preserved.',
    });
  } else if (isUniversalEngineJob(job)) {
    emitLifecycle(job, GenerationEventType.CANCELLED, {
      message: 'Generation cancelled.',
      data: { generationType: job.taskType },
    });
  }
  return true;
}

/**
 * Deletes a job and everything the queue owns for it (its durable event log).
 *
 * Any state can be deleted. An active job is cancelled first — cooperatively,
 * exactly like `cancelJob`, so the worker observes the cancellation and never
 * writes generated content afterwards — and then removed together with its
 * events. Notifications and usage accounting are deliberately kept: they are
 * the author's history and the billing record, not queue state.
 *
 * Returns false when the job does not exist (already deleted or never owned).
 */
export function deleteJob(id: string): boolean {
  const db = getDb();
  const job = db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(id) as JobRecord | undefined;
  if (!job) return false;

  const active = ['queued', 'processing', 'awaiting_review'].includes(job.status);
  if (active) {
    // Cancel first so chapter status, lifecycle events and the worker's
    // cancellation checks all observe the same transition they would for a
    // plain cancel; the row is removed immediately afterwards.
    cancelJob(id);
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM generation_events WHERE jobId=?').run(id);
    const res = db.prepare('DELETE FROM generation_jobs WHERE id=?').run(id);
    return res.changes > 0;
  });
  return tx();
}

/**
 * Re-queues a failed or cancelled job so the user can retry it safely.
 * Retrying never duplicates a chapter: the worker checks whether the chapter
 * was already completed by another attempt before writing.
 */
export async function retryJob(id: string, options: { priority?: number } = {}): Promise<boolean> {
  const db = getDb();
  const now = nowIso();
  const job = db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(id) as JobRecord | undefined;
  if (!job) return false;

  // ONE retry path for every task type.
  // A newer attempt may already be running for this chapter. Re-queueing the
  // old row would violate the active-idempotency index and could write the
  // chapter twice, so the retry is refused instead.
  if (job.idempotencyKey) {
    const conflict = db
      .prepare(
        `SELECT id FROM generation_jobs
          WHERE idempotencyKey=? AND id!=? AND status IN ('queued','processing') LIMIT 1`
      ).get(job.idempotencyKey, id) as { id: string } | undefined;
    if (conflict) return false;
  }

  const res = db.prepare(
    `UPDATE generation_jobs
        SET status='queued', attempts=0, error=NULL, errorCode=NULL, retryable=1,
            scheduledAt=?, completedAt=NULL, claimedAt=NULL, claimedBy=NULL, progress=0,
            progressPercentage=NULL, currentStage=NULL, cancelRequestedAt=NULL, updatedAt=?
      WHERE id=? AND status IN ('failed','cancelled')`
  ).run(now, now, id);
  if (res.changes === 0) return false;

  if (job.taskType === 'chapter') {
    updateChapterGenerationStatus(job.chapterId, 'QUEUED');
    emitLifecycle({ ...job, attempts: 0 }, GenerationEventType.QUEUED, {
      data: { manualRetry: true },
    });
  } else if (isUniversalEngineJob(job)) {
    emitLifecycle({ ...job, attempts: 0 }, GenerationEventType.QUEUED, {
      data: { manualRetry: true, generationType: job.taskType },
    });
  }
  await dispatch(id, { priority: options.priority ?? job.priority ?? 0 });
  return true;
}

/** Public shape of a job for API responses (no raw payload/result passthrough). */
export function serializeJob(job: JobRecord) {
  return {
    id: job.id,
    novelId: job.novelId,
    chapterId: job.chapterId ?? null,
    taskType: job.taskType,
    status: job.status,
    publicStatus: toPublicStatus(job.status),
    progress: job.progress ?? 0,
    progressPercentage: job.progressPercentage ?? null,
    indeterminate: job.taskType === 'chapter' && !job.completedAt,
    currentStage: job.currentStage ?? null,
    currentStageLabel: stageLabel(job.currentStage),
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: job.error ? sanitizeErrorMessage(job.error) : null,
    errorCode: job.errorCode ?? null,
    retryable: job.retryable === undefined || job.retryable === null ? true : Boolean(job.retryable),
    result: safeJson(job.result),
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    cancelRequestedAt: job.cancelRequestedAt ?? null,
  };
}

function safeJson(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
