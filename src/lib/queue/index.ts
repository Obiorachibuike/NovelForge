import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import type { GenerationTask } from '@/types';
import 'server-only';

/**
 * A minimal, provider-independent job enqueue API.
 *
 * When QUEUE_PROVIDER=redis and REDIS_URL is set, callers can add BullMQ; the
 * default in-process runner is sufficient for development and single-instance
 * deployments and is used automatically. Jobs are always persisted in the
 * `generation_jobs` table so they survive restarts.
 */

type JobHandler = (job: { id:string; payload: Record<string,unknown>; novelId:string; userId:string }) => Promise<unknown>;
const handlers = new Map<string, JobHandler>();

export function registerHandler(taskType: string, handler: (job: any) => Promise<unknown>) {
  handlers.set(taskType, handler);
}

export async function enqueue(task: GenerationTask): Promise<string> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = nanoid();

  // Idempotency: if a non-terminal job exists with the same idempotency key, return it.
  if (task.idempotencyKey) {
    const existing = db.prepare(
      `SELECT id FROM generation_jobs WHERE idempotencyKey = ? AND status IN ('queued','processing')`
    ).get(task.idempotencyKey) as any;
    if (existing) return existing.id;
  }

  db.prepare(
    `INSERT INTO generation_jobs (id,userId,novelId,taskType,payload,status,attempts,maxAttempts,idempotencyKey,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, task.userId, task.novelId, task.type,
    JSON.stringify(task.payload), 'queued', 0, 3,
    task.idempotencyKey || null, now, now,
  );

  // In in-process mode, kick the job immediately but do NOT block the caller.
  if (process.env.QUEUE_PROVIDER !== 'redis' || !process.env.REDIS_URL) {
    setImmediate(() => void runJob(id).catch(err => console.error('[queue] job failed', id, err)));
  }
  return id;
}

export async function getJob(id: string) {
  const db = getDb();
  return db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id) as any;
}

export async function listJobs(novelId: string, { limit = 20 } = {}) {
  const db = getDb();
  return db.prepare('SELECT * FROM generation_jobs WHERE novelId = ? ORDER BY createdAt DESC LIMIT ?').all(novelId, limit) as any[];
}

export async function runJob(id: string) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id) as any;
  if (!job || job.status === 'completed' || job.status === 'cancelled') return;

  const handler = handlers.get(job.taskType);
  if (!handler) {
    db.prepare(`UPDATE generation_jobs SET status='failed', error=?, updatedAt=? WHERE id=?`)
      .run(`No handler registered for task type ${job.taskType}`, new Date().toISOString(), id);
    return;
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE generation_jobs SET status='processing', attempts=attempts+1, startedAt=COALESCE(startedAt, ?), updatedAt=? WHERE id=?`)
    .run(now, now, id);
  try {
    const payload = JSON.parse(job.payload || '{}');
    const result = await handler({ id, payload, novelId: job.novelId, userId: job.userId });
    const finished = new Date().toISOString();
    db.prepare(`UPDATE generation_jobs SET status='completed', result=?, completedAt=?, updatedAt=? WHERE id=?`)
      .run(JSON.stringify(result ?? null), finished, finished, id);
  } catch (err: any) {
    const msg = err?.message || String(err);
    const attempts = (job.attempts || 0) + 1;
    const nextStatus = attempts >= job.maxAttempts ? 'failed' : 'queued';
    db.prepare(`UPDATE generation_jobs SET status=?, error=?, updatedAt=? WHERE id=?`)
      .run(nextStatus, msg, new Date().toISOString(), id);
    if (nextStatus === 'queued') {
      setTimeout(() => void runJob(id).catch(e => console.error('[queue] retry failed', id, e)), 2000 * attempts);
    }
  }
}

/** Kick any straggler jobs on startup. */
export function initQueue() {
  const db = getDb();
  const stuck = db.prepare(`SELECT id FROM generation_jobs WHERE status IN ('queued','processing') ORDER BY createdAt ASC LIMIT 20`).all() as any[];
  for (const s of stuck) {
    setImmediate(() => void runJob(s.id).catch(err => console.error('[queue] init job failed', s.id, err)));
  }
}
