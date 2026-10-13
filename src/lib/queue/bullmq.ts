import 'server-only';

/**
 * BullMQ transport.
 *
 * Redis is used only as a delivery channel for durable job ids that live in the
 * `generation_jobs` table. If Redis is unavailable, `enqueue()` logs the failure
 * and the job stays claimable by the database poller / recovery sweep, so no
 * work is lost.
 *
 * `bullmq` and `ioredis` are imported lazily so deployments that do not enable
 * Redis mode never open a connection.
 */
export const QUEUE_NAME = 'novelforge-jobs';

function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not configured');
  return url;
}

type BullQueue = import('bullmq').Queue;
type BullWorker = import('bullmq').Worker;
type Redis = import('ioredis').default;

let _queue: BullQueue | null = null;
let _connection: Redis | null = null;

async function connection(): Promise<Redis> {
  if (_connection) return _connection;
  const { default: IORedis } = await import('ioredis');
  _connection = new IORedis(redisUrl(), { maxRetriesPerRequest: null, enableReadyCheck: true });
  return _connection;
}

/** Producer used by the Next.js runtime to hand a job id to the worker. */
export async function publishJob(jobId: string, delayMs = 0): Promise<void> {
  const { Queue } = await import('bullmq');
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, { connection: await connection() });
  }
  const delay = Math.max(0, Math.round(delayMs));
  await _queue.add('run-job', { jobId }, {
    jobId: `${jobId}:${Math.random().toString(36).slice(2, 8)}`,
    delay,
    attempts: 1,
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}

/**
 * Consumer used by `npm run worker`. The handler receives a job id and runs it
 * through the shared claim path, so BullMQ redelivery can never double-execute.
 */
export async function startBullWorker(
  runById: (jobId: string, workerId: string) => Promise<unknown>,
  { concurrency = 2, workerId = `bull-${process.pid}` } = {},
): Promise<BullWorker> {
  const { Worker } = await import('bullmq');
  const worker = new Worker(
    QUEUE_NAME,
    async job => {
      const { jobId } = job.data as { jobId: string };
      return runById(jobId, workerId);
    },
    { connection: await connection(), concurrency },
  );
  worker.on('failed', (job, err) => console.error('[bullmq] job failed', job?.id, err?.message));
  worker.on('error', err => console.error('[bullmq] worker error', err));
  return worker;
}

export async function closeBullQueue(): Promise<void> {
  try { await _queue?.close(); } catch { /* ignore */ }
  try { await _connection?.quit(); } catch { /* ignore */ }
  _queue = null;
  _connection = null;
}
