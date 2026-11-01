import { getDb, closeDb, activeDatabaseDriver } from '@/lib/db';
import { drainQueue, recoverStaleJobs, runJob } from '@/lib/queue';
import {
  chapterQueueInfo,
  queueTransport,
  workerConcurrency,
  CHAPTER_GENERATION_QUEUE,
} from './queues';
import { startChapterGenerationWorker, stopBoss } from './boss';

/**
 * Dedicated background worker (deployment process B).
 *
 * Run with `npm run worker` in a hosting environment that supports a
 * persistent Node.js process (Fly, Railway, Render, a container, a VM...).
 * It is intentionally *not* started from a Next.js request: serverless
 * functions are frozen after a response, which would silently stop generation.
 *
 * Two consumption paths run side by side:
 *  1. pg-boss delivers wake-ups for every generation task (PostgreSQL).
 *  2. The database sweep recovers interrupted jobs and catches any wake-up
 *     pg-boss missed; SQLite development uses the same durable poller.
 *
 * The compare-and-set claim in `runJob` makes double delivery harmless.
 */

// Importing the services registers their job handlers in this process.
import '@/services/images/service';
import '@/services/preparation/service';
import '@/services/outlines/service';
import '@/services/chapters/service';
import '@/services/generation/universal-text';
import '@/services/consistency/service';
import '@/services/exports/service';

export interface WorkerHandle {
  stop: (signal?: string) => Promise<void>;
  info: ReturnType<typeof chapterQueueInfo> & { concurrency: number; pollMs: number };
}

export async function startWorker(options: {
  concurrency?: number;
  pollMs?: number;
  /** Set false in tests that drive the database sweep directly. */
  registerPgBoss?: boolean;
  log?: (message: string) => void;
} = {}): Promise<WorkerHandle> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const concurrency = Math.max(1, options.concurrency ?? workerConcurrency());
  const pollMs = Math.max(250, options.pollMs ?? Number(process.env.WORKER_POLL_MS || 3000));
  const workerId = `worker-${process.pid}`;

  // Opening the database applies any pending migrations before consuming work.
  getDb();
  const driver = activeDatabaseDriver();
  const transport = queueTransport();

  if (transport === 'pgboss' && driver !== 'postgres') {
    throw new Error(
      'pg-boss is enabled but DATABASE_URL is not PostgreSQL. Set DATABASE_URL to postgres://... or QUEUE_PROVIDER=database for SQLite development.',
    );
  }

  let workerRegistration: string | null = null;
  if (options.registerPgBoss !== false) {
    try {
      workerRegistration = await startChapterGenerationWorker((jobId, id) => runJob(jobId, id), {
        concurrency,
        workerId,
      });
      if (workerRegistration) {
        log(
          `[worker] pg-boss consumer listening on ${CHAPTER_GENERATION_QUEUE} (concurrency=${concurrency})`,
        );
      }
    } catch (err) {
      // pg-boss is transport, not the source of truth. If it cannot start
      // (permissions, schema creation, a queue outage), keep the durable
      // database sweep running so queued work is still picked up.
      console.error(
        '[worker] pg-boss consumer unavailable; continuing with the database sweep:',
        err,
      );
    }
  }

  let stopping = false;
  let ticking = false;
  const inFlight = new Set<string>();

  const tick = async () => {
    if (stopping || ticking || inFlight.size >= concurrency) return;
    ticking = true;
    try {
      const recovered = await recoverStaleJobs({ limit: Math.max(5, concurrency * 2) });
      if (recovered.recovered) log(`[worker] recovered ${recovered.recovered} stale job(s)`);

      const capacity = Math.max(1, concurrency - inFlight.size);
      const due = recovered.due.slice(0, capacity);
      await Promise.all(
        due.map(async id => {
          if (inFlight.has(id)) return;
          inFlight.add(id);
          try {
            await runJob(id, workerId);
          } catch (err) {
            console.error(`[worker] job ${id} failed unexpectedly`, err);
          } finally {
            inFlight.delete(id);
          }
        }),
      );
    } catch (err) {
      console.error('[worker] poll failed:', err);
    } finally {
      ticking = false;
    }
  };

  await tick();
  // This interval is the worker's only handle when pg-boss is disabled
  // (SQLite development). It must keep the process alive: never unref it.
  const timer = setInterval(() => { void tick(); }, pollMs);

  const info = {
    ...chapterQueueInfo(),
    concurrency,
    pollMs,
  };

  log(
    `[worker] ready (transport=${transport}, database=${driver}, concurrency=${concurrency}, poll=${pollMs}ms, pgBossWorker=${Boolean(workerRegistration)})`,
  );

  const stop = async (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    log(`[worker] ${signal} received — finishing in-flight jobs and shutting down`);
    clearInterval(timer);

    // Give cooperative handlers a bounded window to finish. pg-boss graceful
    // shutdown waits for its own consumers; the database rows remain claimable
    // if the process is killed first.
    const deadline = Date.now() + Number(process.env.WORKER_SHUTDOWN_MS || 25_000);
    while (inFlight.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await stopBoss();
    closeDb();
    log('[worker] stopped');
  };

  return { stop, info };
}

/** Kept for tests and tooling that only need one sweep. */
export async function runOneSweep(limit = 5): Promise<void> {
  await drainQueue({ limit, workerId: `sweep-${process.pid}` });
}
