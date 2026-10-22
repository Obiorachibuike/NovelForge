import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import type { GenerationTask } from '@/types';
import 'server-only';

/**
 * Durable job queue.
 *
 * Every job is a row in `generation_jobs`; Redis/BullMQ (when configured) only
 * carries the *wake-up* for a job id, so a Redis flush can never lose work — the
 * row remains claimable by the recovery sweep.
 *
 * Guarantees:
 *  - Idempotency: `idempotencyKey` is enforced by a partial unique index over
 *    active jobs (`ux_jobs_active_idempotency`), so concurrent duplicate
 *    requests cannot both enqueue.
 *  - Single execution: `runJob` claims a job with a compare-and-set UPDATE and
 *    only runs the handler when that UPDATE changed a row.
 *  - Retries: failed attempts are rescheduled with exponential backoff in
 *    `scheduledAt` until `maxAttempts` is reached.
 *  - Recovery: `recoverStaleJobs` requeues jobs whose worker died mid-flight.
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

export interface JobRecord {
  id: string;
  userId: string;
  novelId: string;
  chapterId?: string | null;
  taskType: string;
  payload: string;
  status: JobStatus;
  result: string | null;
  error: string | null;
  errorCode?: string | null;
  retryable?: number | null;
  attempts: number;
  /** Hosted-inference provenance (which model was asked for, which one answered). */
  requestedModel?: string | null;
  actualModel?: string | null;
  provider?: string | null;
  fallbackCount?: number | null;
  durationMs?: number | null;
  maxAttempts: number;
  idempotencyKey: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string | null;
  claimedBy?: string | null;
  scheduledAt?: string | null;
  progress?: number | null;
}

export interface JobHandlerContext {
  id: string;
  payload: Record<string, unknown>;
  novelId: string;
  userId: string;
  /** Persists 0-100 progress so the status endpoint can report it. */
  setProgress: (percent: number) => void;
  /** True if the job was cancelled while running. */
  isCancelled: () => boolean;
}

type JobHandler = (job: JobHandlerContext) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();

export function registerHandler(taskType: string, handler: JobHandler) {
  handlers.set(taskType, handler);
}

export function hasHandler(taskType: string): boolean {
  return handlers.has(taskType);
}

/** True when the deployment is configured to dispatch through Redis/BullMQ. */
export function queueDriver(): 'redis' | 'inprocess' {
  return process.env.QUEUE_PROVIDER === 'redis' && !!process.env.REDIS_URL ? 'redis' : 'inprocess';
}

export function queueInfo() {
  const driver = queueDriver();
  return {
    driver,
    // The BullMQ path is only honest about what it is: a wake-up channel over a
    // durable SQLite row.
    redisConfigured: !!process.env.REDIS_URL,
    note: driver === 'redis'
      ? 'BullMQ delivers job wake-ups; job state itself is persisted in the database.'
      : 'Jobs run in-process and are persisted in the database; a separate worker (npm run worker) drains them.',
  };
}

function nowIso() { return new Date().toISOString(); }

function envInt(name: string, fallback: number) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export interface EnqueueOptions extends GenerationTask {
  chapterId?: string | null;
  maxAttempts?: number;
  /** Milliseconds to wait before the job may first be claimed. */
  delayMs?: number;
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
    db.prepare(
      `INSERT INTO generation_jobs (id,userId,novelId,chapterId,taskType,payload,status,attempts,maxAttempts,idempotencyKey,createdAt,updatedAt,scheduledAt,progress,retryable)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    ).run(
      id, task.userId, task.novelId, task.chapterId || null, task.type, JSON.stringify(task.payload ?? {}),
      'queued', 0, task.maxAttempts ?? 3, task.idempotencyKey || null, now, now,
      task.delayMs ? new Date(Date.now() + task.delayMs).toISOString() : now, 0,
    );
  } catch (err) {
    // Partial unique index violation: another request enqueued the same work
    // between our SELECT and INSERT.
    if (task.idempotencyKey && String(err).includes('UNIQUE')) {
      const existing = db.prepare(
        `SELECT id FROM generation_jobs WHERE idempotencyKey = ? AND status IN ('queued','processing')`,
      ).get(task.idempotencyKey) as { id: string } | undefined;
      if (existing) return existing.id;
    }
    throw err;
  }

  if (queueDriver() === 'redis') {
    const { publishJob } = await import('./bullmq');
    try {
      await publishJob(id);
    } catch (err) {
      // The row is durable and the recovery sweep will pick it up; surface the
      // problem loudly rather than pretending the job was dispatched.
      console.error('[queue] BullMQ publish failed; job remains queued in the database:', err);
    }
  } else if (!process.env.QUEUE_NO_INPROCESS) {
    setImmediate(() => {
      void runJob(id).catch(err => console.error('[queue] job failed', id, err));
    });
  }
  return id;
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
 * "generate chapter N" safe against duplicate/burst requests.
 */
export async function runJob(id: string, workerId = `${process.pid}`): Promise<JobRunResult> {
  const db = getDb();
  const now = nowIso();
  const claim = db.prepare(
    `UPDATE generation_jobs
        SET status='processing', attempts=attempts+1, claimedAt=?, claimedBy=?,
            startedAt=COALESCE(startedAt,?), updatedAt=?
      WHERE id=?
        AND status='queued'
        AND (scheduledAt IS NULL OR scheduledAt <= ?)`,
  ).run(now, workerId, now, now, id, now);

  if (claim.changes === 0) {
    const row = db.prepare('SELECT status FROM generation_jobs WHERE id=?').get(id) as { status: JobStatus } | undefined;
    return { id, status: 'skipped', reason: row ? `not claimable (status=${row.status})` : 'missing' };
  }

  const job = db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(id) as JobRecord;
  const handler = handlers.get(job.taskType);
  if (!handler) {
    db.prepare(`UPDATE generation_jobs SET status='failed', error=?, errorCode='no_handler', retryable=0, completedAt=?, updatedAt=? WHERE id=?`)
      .run(`No handler registered for task type ${job.taskType}`, nowIso(), nowIso(), id);
    return { id, status: 'failed', reason: 'no handler' };
  }

  const checkCancelled = () => {
    const row = db.prepare('SELECT status FROM generation_jobs WHERE id=?').get(id) as { status: JobStatus } | undefined;
    return !row || row.status === 'cancelled';
  };

  try {
    const payload = job.payload ? JSON.parse(job.payload) : {};
    const result = await handler({
      id, payload, novelId: job.novelId, userId: job.userId,
      isCancelled: checkCancelled,
      setProgress: percent => {
        const value = Math.max(0, Math.min(100, Math.round(percent)));
        db.prepare(`UPDATE generation_jobs SET progress=?, updatedAt=? WHERE id=? AND status='processing'`).run(value, nowIso(), id);
      },
    });
    const finished = nowIso();
    const targetStatus: JobStatus = (result && typeof result === 'object' && (result as any).awaitingReview === true)
      ? 'awaiting_review'
      : 'completed';
    const completeUpdate = db.prepare(
      `UPDATE generation_jobs
          SET status=?, result=?, error=NULL, errorCode=NULL, completedAt=?, updatedAt=?, claimedAt=NULL, claimedBy=NULL, progress=100
        WHERE id=? AND status='processing'`,
    ).run(targetStatus, JSON.stringify(result ?? null), finished, finished, id);
    if (completeUpdate.changes === 0) {
      return { id, status: 'cancelled', reason: 'cancelled while processing' };
    }
    return { id, status: targetStatus };
  } catch (err) {
    if (checkCancelled()) {
      db.prepare(`UPDATE generation_jobs SET claimedAt=NULL, claimedBy=NULL, updatedAt=? WHERE id=?`).run(nowIso(), id);
      return { id, status: 'cancelled', reason: 'cancelled' };
    }
    const classified = classifyJobError(err);
    const attempts = (db.prepare('SELECT attempts FROM generation_jobs WHERE id=?').get(id) as { attempts: number }).attempts;
    const maxAttempts = job.maxAttempts || 3;
    const finished = nowIso();
    if (!classified.retryable || attempts >= maxAttempts) {
      db.prepare(
        `UPDATE generation_jobs
            SET status='failed', error=?, errorCode=?, retryable=?, completedAt=?, updatedAt=?, claimedAt=NULL, claimedBy=NULL
          WHERE id=? AND status != 'cancelled'`,
      ).run(classified.message, classified.code, classified.retryable ? 1 : 0, finished, finished, id);
      return { id, status: 'failed', reason: classified.message };
    }
    const backoffMs = Math.min(60_000, 2000 * 2 ** (attempts - 1));
    db.prepare(
      `UPDATE generation_jobs
          SET status='queued', error=?, errorCode=?, retryable=1, scheduledAt=?, updatedAt=?, claimedAt=NULL, claimedBy=NULL
        WHERE id=? AND status != 'cancelled'`,
    ).run(classified.message, classified.code, new Date(Date.now() + backoffMs).toISOString(), finished, id);
    if (queueDriver() === 'redis') {
      const { publishJob } = await import('./bullmq');
      await publishJob(id, backoffMs).catch(e => console.error('[queue] retry publish failed', id, e));
    } else if (!process.env.QUEUE_NO_INPROCESS) {
      setTimeout(() => { void runJob(id).catch(e => console.error('[queue] retry failed', id, e)); }, backoffMs);
    }
    return { id, status: 'queued', reason: classified.message };
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
    `UPDATE generation_jobs
        SET status='queued', claimedAt=NULL, claimedBy=NULL, scheduledAt=?, updatedAt=?,
            error=COALESCE(error, 'Recovered from an interrupted worker')
      WHERE status='processing' AND (claimedAt IS NULL OR claimedAt < ?)`,
  ).run(nowIso(), nowIso(), cutoff);

  const due = db.prepare(
    `SELECT id FROM generation_jobs
      WHERE status='queued' AND (scheduledAt IS NULL OR scheduledAt <= ?)
      ORDER BY createdAt ASC LIMIT ?`,
  ).all(nowIso(), limit) as { id: string }[];

  return { recovered: stale.changes, due: due.map(d => d.id) };
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

/**
 * Marks a queued or processing job as cancelled. Returns false when it has
 * already finished (completed, failed, or cancelled).
 */
export function cancelJob(id: string): boolean {
  const db = getDb();
  const res = db.prepare(
    `UPDATE generation_jobs
        SET status='cancelled', updatedAt=?, completedAt=COALESCE(completedAt, ?), claimedAt=NULL, claimedBy=NULL
      WHERE id=? AND status IN ('queued','processing','awaiting_review')`,
  ).run(nowIso(), nowIso(), id);
  return res.changes > 0;
}

/**
 * Re-queues a failed or cancelled job so the user can retry it safely.
 */
export async function retryJob(id: string): Promise<boolean> {
  const db = getDb();
  const now = nowIso();
  const res = db.prepare(
    `UPDATE generation_jobs
        SET status='queued', attempts=0, error=NULL, errorCode=NULL, retryable=1,
            scheduledAt=?, completedAt=NULL, claimedAt=NULL, claimedBy=NULL, progress=0, updatedAt=?
      WHERE id=? AND status IN ('failed','cancelled')`,
  ).run(now, now, id);
  if (res.changes === 0) return false;

  if (queueDriver() === 'redis') {
    const { publishJob } = await import('./bullmq');
    await publishJob(id).catch(e => console.error('[queue] retry publish failed', id, e));
  } else if (!process.env.QUEUE_NO_INPROCESS) {
    setImmediate(() => { void runJob(id).catch(e => console.error('[queue] retry failed', id, e)); });
  }
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
    progress: job.progress ?? 0,
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
  };
}

function safeJson(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Startup hook. In database mode it schedules a recovery sweep; in Redis mode
 * the worker module owns the timer (see src/worker/index.ts).
 */
export async function initQueue() {
  await recoverStaleJobs();
}
