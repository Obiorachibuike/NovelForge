/**
 * Standalone worker.
 *
 *   npm run worker        # database mode (default) or BullMQ when Redis is configured
 *
 * In both modes the job *state* lives in the `generation_jobs` table; Redis only
 * carries wake-ups. The claim in `runJob` is a compare-and-set UPDATE, so the
 * BullMQ consumer, the database poller and a stray in-process dispatch can all
 * race safely without executing the same job twice.
 */
import { getDb } from '@/lib/db';
import { drainQueue, queueDriver, runJob, recoverStaleJobs } from '@/lib/queue';

// Importing the services registers their job handlers.
import '@/services/images/service';
import '@/services/preparation/service';
import '@/services/outlines/service';
import '@/services/chapters/service';
import '@/services/consistency/service';
import '@/services/exports/service';

const POLL_MS = Number(process.env.WORKER_POLL_MS || 3000);
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 2));

async function main() {
  const db = getDb();
  const driver = queueDriver();
  const workerId = `worker-${process.pid}`;

  if (driver === 'redis') {
    const { startBullWorker } = await import('@/lib/queue/bullmq');
    await startBullWorker((jobId, id) => runJob(jobId, id), { concurrency: CONCURRENCY, workerId });
    console.log('[worker] BullMQ consumer listening on the Redis queue');
  }

  // Database safety net in both modes: recovers jobs abandoned by a crashed
  // worker and drains anything Redis missed (e.g. publish failed).
  const tick = async () => {
    try {
      const recovered = await recoverStaleJobs({ limit: 20 });
      if (recovered.recovered) console.warn(`[worker] recovered ${recovered.recovered} stale job(s)`);
      await drainQueue({ limit: CONCURRENCY, workerId });
    } catch (err) {
      console.error('[worker] poll failed:', err);
    }
  };

  await tick();
  const timer = setInterval(tick, POLL_MS);
  console.log(`[worker] ready (driver=${driver}, concurrency=${CONCURRENCY}, poll=${POLL_MS}ms)`);

  const shutdown = (signal: string) => {
    console.log(`[worker] ${signal} received — finishing current jobs`);
    clearInterval(timer);
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => { console.error('[worker] fatal', err); process.exit(1); });
