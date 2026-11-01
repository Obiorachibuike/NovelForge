import 'server-only';
import { isPostgresUrl } from '@/lib/db/postgres';
import {
  CHAPTER_GENERATION_QUEUE,
  chapterQueueOptions,
  queueTransport,
} from './queues';

/**
 * pg-boss is ESM-only. A plain `import('pg-boss')` inside a webpack CommonJS
 * server bundle can be compiled into `require()`, which throws
 * `ERR_REQUIRE_ESM`. Evaluating the import natively keeps it a dynamic ESM
 * import for both `tsx` (the worker) and the bundled Next.js server.
 */
const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<any>;

/**
 * pg-boss: the PostgreSQL-backed background job queue.
 *
 * Two deployment roles use this module:
 *
 *  - the Next.js runtime only *produces* wake-ups (`sendChapterGeneration`);
 *  - `npm run worker` consumes them (`startChapterGenerationWorker`).
 *
 * pg-boss is initialized lazily and never inside a request's long-running
 * generation path. The worker is a separate persistent Node process, so a
 * browser tab closing (or the Next.js process restarting) cannot stop work.
 *
 * The payload is only the durable `generation_jobs.id`. All generation state,
 * retries and progress remain in NovelForge's own tables, which means a lost
 * queue message can always be recovered by the worker's database sweep.
 */

export interface ChapterJobPayload {
  dbJobId: string;
}

/** Minimal structural type so tests can inject a deterministic fake. */
export interface BossLike {
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean; close?: boolean; timeout?: number }): Promise<void>;
  createQueue?(name: string, options?: Record<string, unknown>): Promise<void>;
  send(
    name: string,
    data: object | null,
    options?: Record<string, unknown>,
  ): Promise<string | null>;
  work(
    name: string,
    options: Record<string, unknown>,
    handler: (jobs: Array<{ id: string; data: ChapterJobPayload }>) => Promise<unknown>,
  ): Promise<string>;
}

let bossInstance: BossLike | null = null;
let bossPromise: Promise<BossLike> | null = null;
let testBoss: BossLike | null = null;
let startedForTests = false;

/** Test seam: inject a fake pg-boss instance (or null to restore the real one). */
export function __setBossForTests(boss: BossLike | null) {
  testBoss = boss;
  startedForTests = false;
  if (!boss) {
    bossInstance = null;
    bossPromise = null;
  }
}

export function isPgBossEnabled(): boolean {
  return queueTransport() === 'pgboss';
}

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!isPostgresUrl(url)) {
    throw new Error(
      'pg-boss requires a PostgreSQL DATABASE_URL. Set QUEUE_PROVIDER=database only for SQLite development/test runs.',
    );
  }
  return url!;
}

async function ensureChapterQueue(boss: BossLike): Promise<void> {
  if (!boss.createQueue) return;
  try {
    await boss.createQueue(CHAPTER_GENERATION_QUEUE, {
      retryLimit: chapterQueueOptions().retryLimit,
      retryDelay: chapterQueueOptions().retryDelay,
      retryBackoff: true,
      expireInSeconds: chapterQueueOptions().expireInSeconds,
      retentionSeconds: chapterQueueOptions().retentionSeconds,
      deleteAfterSeconds: chapterQueueOptions().deleteAfterSeconds,
      // A `stately` queue keyed by the database job id allows one queued and
      // one active entry per generation, while leaving other generations
      // independent. `standard` would accept unlimited duplicates.
      policy: 'stately',
    });
  } catch (err) {
    // pg-boss versions differ on whether createQueue is idempotent. An
    // "already exists" error means the queue is ready, which is success.
    const message = err instanceof Error ? err.message : String(err);
    if (!/already exists|exists already|duplicate/i.test(message)) throw err;
  }
}

/**
 * Returns a started pg-boss instance (singleton per Node process).
 * Callers in the Next.js runtime should treat failures as non-fatal: the
 * durable row stays queued and the worker's recovery sweep picks it up.
 */
export async function getBoss(): Promise<BossLike> {
  if (testBoss) {
    if (!startedForTests) {
      await testBoss.start();
      await ensureChapterQueue(testBoss);
      startedForTests = true;
    }
    return testBoss;
  }
  if (bossInstance) return bossInstance;
  if (bossPromise) return bossPromise;

  bossPromise = (async () => {
    const { PgBoss } = await nativeImport('pg-boss');
    const boss = new PgBoss({
      connectionString: connectionString(),
      max: Number(process.env.PG_BOSS_POOL_MAX || 5),
      application_name: process.env.PG_BOSS_APPLICATION_NAME || 'novelforge',
      schedule: false,
      supervise: true,
    }) as unknown as BossLike;

    (boss as unknown as { on?: (event: string, cb: (...args: unknown[]) => void) => void }).on?.(
      'error',
      (...args: unknown[]) => console.error('[pg-boss] error', ...args),
    );

    await boss.start();
    await ensureChapterQueue(boss);
    bossInstance = boss;
    return boss;
  })();

  try {
    return await bossPromise;
  } catch (err) {
    bossPromise = null;
    throw err;
  }
}

/**
 * Enqueues (or re-wakes) one durable generation job.
 *
 * `singletonKey` is the database job id inside a `stately` queue, so pg-boss
 * itself refuses to hold two queued/active entries for the same generation.
 * Returns null when pg-boss deduplicated the send.
 */
export async function sendChapterGeneration(
  dbJobId: string,
  options: { priority?: number; delayMs?: number } = {},
): Promise<string | null> {
  if (!isPgBossEnabled()) return null;
  const boss = await getBoss();
  const opts = chapterQueueOptions();
  return boss.send(
    CHAPTER_GENERATION_QUEUE,
    { dbJobId } satisfies ChapterJobPayload,
    {
      singletonKey: `chapter-generation:${dbJobId}`,
      priority: options.priority ?? 0,
      retryLimit: opts.retryLimit,
      retryDelay: opts.retryDelay,
      retryBackoff: opts.retryBackoff,
      expireInSeconds: opts.expireInSeconds,
      ...(options.delayMs && options.delayMs > 0
        ? { startAfter: new Date(Date.now() + options.delayMs) }
        : {}),
    },
  );
}

/**
 * Starts consuming the chapter-generation queue. Only the dedicated worker
 * process should call this; it resolves once pg-boss has registered the worker.
 */
export async function startChapterGenerationWorker(
  run: (dbJobId: string, workerId: string) => Promise<unknown>,
  options: { concurrency?: number; workerId?: string } = {},
): Promise<string | null> {
  if (!isPgBossEnabled()) return null;
  const boss = await getBoss();
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const workerId = options.workerId || `pgboss-${process.pid}`;

  return boss.work(
    CHAPTER_GENERATION_QUEUE,
    { batchSize: 1, localConcurrency: concurrency, pollingIntervalSeconds: 2 },
    async jobs => {
      const results: unknown[] = [];
      for (const job of jobs) {
        const dbJobId = job.data?.dbJobId;
        if (!dbJobId) {
          console.warn('[pg-boss] queue job without dbJobId; ignoring', job.id);
          continue;
        }
        results.push(await run(dbJobId, workerId));
      }
      return results;
    },
  );
}

/** Graceful shutdown: lets in-flight jobs finish before closing the pool. */
export async function stopBoss(): Promise<void> {
  const boss = testBoss || bossInstance;
  if (!boss) return;
  try {
    await boss.stop({
      graceful: true,
      close: true,
      timeout: Number(process.env.WORKER_SHUTDOWN_MS || 25_000),
    });
  } catch (err) {
    console.error('[pg-boss] shutdown failed', err);
  } finally {
    bossInstance = null;
    bossPromise = null;
    startedForTests = false;
  }
}

/** Lightweight reporting for /api/health and the settings page. */
export async function bossHealth(): Promise<'disabled' | 'connected' | 'unavailable'> {
  if (!isPgBossEnabled()) return 'disabled';
  try {
    const boss = await getBoss();
    if (typeof (boss as any).getQueue === 'function') {
      const queue = await (boss as any).getQueue(CHAPTER_GENERATION_QUEUE);
      return queue ? 'connected' : 'unavailable';
    }
    return 'connected';
  } catch {
    return 'unavailable';
  }
}
