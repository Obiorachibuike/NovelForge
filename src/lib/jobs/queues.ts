import 'server-only';
import { isPostgresUrl } from '@/lib/db/postgres';

/**
 * Queue naming and transport selection.
 *
 * Background chapter generation is delivered by pg-boss (PostgreSQL) in
 * production. SQLite is used only for local development and the unit-test
 * harness, where pg-boss cannot run; there the durable `generation_jobs` table
 * itself is the queue and the worker poller drains it. The *durable state* is
 * always the database row — pg-boss is the wake-up/retry transport, never the
 * source of truth.
 */

export const CHAPTER_GENERATION_QUEUE =
  process.env.PG_BOSS_CHAPTER_QUEUE || 'novelforge.chapter-generation';

export type QueueTransport = 'pgboss' | 'database';

export function queueTransport(
  env: NodeJS.ProcessEnv = process.env,
  databaseUrl: string | undefined = env.DATABASE_URL,
): QueueTransport {
  if (env.QUEUE_PROVIDER === 'database' || env.QUEUE_PROVIDER === 'poll') return 'database';
  if (env.QUEUE_DISABLE_PG_BOSS === 'true') return 'database';
  return isPostgresUrl(databaseUrl) ? 'pgboss' : 'database';
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** pg-boss delivery/retry configuration for the chapter queue. */
export function chapterQueueOptions() {
  return {
    /** A generation worker may legitimately run for several minutes. */
    expireInSeconds: envInt('PG_BOSS_EXPIRE_SECONDS', 30 * 60),
    /** Transport-level retries: the durable DB job has its own exponential backoff. */
    retryLimit: envInt('PG_BOSS_RETRY_LIMIT', 3),
    retryDelay: envInt('PG_BOSS_RETRY_DELAY_SECONDS', 5),
    retryBackoff: true,
    retentionSeconds: envInt('PG_BOSS_RETENTION_SECONDS', 7 * 24 * 60 * 60),
    deleteAfterSeconds: envInt('PG_BOSS_DELETE_AFTER_SECONDS', 24 * 60 * 60),
  };
}

export function workerConcurrency(): number {
  return Math.max(1, Number(process.env.WORKER_CONCURRENCY || process.env.AI_MAX_CONCURRENT_JOBS || 2));
}

export function chapterQueueInfo() {
  const transport = queueTransport();
  return {
    transport,
    pgBoss: transport === 'pgboss',
    queue: CHAPTER_GENERATION_QUEUE,
    note:
      transport === 'pgboss'
        ? `Durable jobs live in PostgreSQL; pg-boss (${CHAPTER_GENERATION_QUEUE}) delivers them to the dedicated worker.`
        : 'Durable jobs live in the database and are drained by the worker poller (SQLite development/test mode).',
  };
}
