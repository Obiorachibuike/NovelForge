import { describe, expect, it, beforeEach, vi } from 'vitest';
import { freshDatabase, seedUser, seedNovel, db } from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId }, } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { enqueue, runJob, getJob, listJobs, recoverStaleJobs, drainQueue, cancelJob, registerHandler, serializeJob, queueDriver, queueInfo } from '@/lib/queue';

let user: { id: string; email: string; name: string };
let novel: { id: string; userId: string };

beforeEach(() => {
  freshDatabase();
  user = seedUser();
  novel = seedNovel(user.id);
  // A deterministic handler that records how often it actually ran.
  delete (globalThis as any).__queueRuns;
});

describe('enqueue + idempotency', () => {
  it('deduplicates concurrent enqueues of the same work through the database', async () => {
    registerHandler('test-dedupe', async () => ({ ok: true }));
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => enqueue({
        type: 'test-dedupe', userId: user.id, novelId: novel.id, payload: { n: 1 }, idempotencyKey: `dedupe:${novel.id}`,
      })),
    );
    const unique = new Set(ids);
    expect(unique.size).toBe(1);
    expect(db().prepare(`SELECT COUNT(*) AS c FROM generation_jobs WHERE idempotencyKey=?`).get(`dedupe:${novel.id}`)).toEqual({ c: 1 });
  });

  it('allows a new job once the previous one finished', async () => {
    registerHandler('test-reuse', async () => ({ ok: true }));
    const key = `reuse:${novel.id}`;
    const first = await enqueue({ type: 'test-reuse', userId: user.id, novelId: novel.id, payload: {}, idempotencyKey: key });
    await runJob(first);
    const second = await enqueue({ type: 'test-reuse', userId: user.id, novelId: novel.id, payload: {}, idempotencyKey: key });
    expect(second).not.toBe(first);
  });
});

describe('execution safety', () => {
  it('runs a job exactly once even when several runners race for it', async () => {
    let runs = 0;
    registerHandler('test-claim', async () => {
      runs++;
      await new Promise(r => setTimeout(r, 30));
      return { runs };
    });
    const id = await enqueue({ type: 'test-claim', userId: user.id, novelId: novel.id, payload: {} });

    const results = await Promise.all([runJob(id, 'w1'), runJob(id, 'w2'), runJob(id, 'w3')]);
    expect(runs).toBe(1);
    expect(results.filter(r => r.status === 'completed')).toHaveLength(1);
    expect(results.filter(r => r.status === 'skipped')).toHaveLength(2);
  });

  it('records failures and retries with backoff until maxAttempts', async () => {
    let attempts = 0;
    registerHandler('test-retry', async () => {
      attempts++;
      throw new Error(`boom ${attempts}`);
    });
    const id = await enqueue({ type: 'test-retry', userId: user.id, novelId: novel.id, payload: {}, maxAttempts: 3 });

    expect((await runJob(id)).status).toBe('queued');
    let job = await getJob(id);
    expect(job?.attempts).toBe(1);
    expect(job?.error).toBe('boom 1');
    expect(job?.scheduledAt && new Date(job.scheduledAt).getTime()).toBeGreaterThan(Date.now());

    // Scheduled in the future: not claimable yet.
    expect((await runJob(id)).status).toBe('skipped');

    // Make it due again and let it fail for the last time.
    db().prepare('UPDATE generation_jobs SET scheduledAt=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), id);
    expect((await runJob(id)).status).toBe('queued');
    db().prepare('UPDATE generation_jobs SET scheduledAt=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), id);
    expect((await runJob(id)).status).toBe('failed');

    job = await getJob(id);
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(3);
    expect(job?.error).toBe('boom 3');
    expect(job?.completedAt).toBeTruthy();
  });

  it('fails a job whose task type has no handler', async () => {
    const id = await enqueue({ type: 'no-such-task', userId: user.id, novelId: novel.id, payload: {} });
    expect((await runJob(id)).status).toBe('failed');
    expect((await getJob(id))?.error).toMatch(/No handler registered/);
  });

  it('progress is persisted for observability', async () => {
    registerHandler('test-progress', async ({ setProgress }) => {
      setProgress(42);
      return { done: true };
    });
    const id = await enqueue({ type: 'test-progress', userId: user.id, novelId: novel.id, payload: {} });
    await runJob(id);
    expect((await getJob(id))?.progress).toBe(100);
  });
});

describe('recovery and cancellation', () => {
  it('requeues jobs abandoned by a dead worker', async () => {
    registerHandler('test-stale', async () => ({ ok: true }));
    const id = await enqueue({ type: 'test-stale', userId: user.id, novelId: novel.id, payload: {} });
    // Simulate a worker that claimed the job and died.
    db().prepare(`UPDATE generation_jobs SET status='processing', claimedAt=?, claimedBy='dead-worker' WHERE id=?`)
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), id);

    const recovered = await recoverStaleJobs({ staleMs: 60_000 });
    expect(recovered.recovered).toBe(1);
    const job = await getJob(id);
    expect(job?.status).toBe('queued');
    expect(job?.claimedBy).toBeNull();

    const results = await drainQueue({ limit: 5, workerId: 'recovered-worker' });
    expect(results.some(r => r.id === id && r.status === 'completed')).toBe(true);
  });

  it('does not reclaim a job that is still running', async () => {
    registerHandler('test-running', async () => ({ ok: true }));
    const id = await enqueue({ type: 'test-running', userId: user.id, novelId: novel.id, payload: {} });
    db().prepare(`UPDATE generation_jobs SET status='processing', claimedAt=? WHERE id=?`).run(new Date().toISOString(), id);
    expect((await recoverStaleJobs({ staleMs: 60_000 })).recovered).toBe(0);
  });

  it('cancelling marks a queued job and prevents execution', async () => {
    registerHandler('test-cancel', async () => {
      throw new Error('should never run');
    });
    const id = await enqueue({ type: 'test-cancel', userId: user.id, novelId: novel.id, payload: {} });
    expect(cancelJob(id)).toBe(true);
    expect((await runJob(id)).status).toBe('skipped');
    expect((await getJob(id))?.status).toBe('cancelled');
  });

  it('listJobs is scoped to a novel and serialisation hides payloads', async () => {
    const other = seedNovel(user.id, { title: 'Other' });
    await enqueue({ type: 'x', userId: user.id, novelId: novel.id, payload: { secret: 'do-not-leak' } });
    await enqueue({ type: 'x', userId: user.id, novelId: other.id, payload: {} });
    const jobs = await listJobs(novel.id);
    expect(jobs).toHaveLength(1);
    const serialized = serializeJob(jobs[0]);
    expect(JSON.stringify(serialized)).not.toContain('do-not-leak');
    expect(serialized).toMatchObject({ novelId: novel.id, status: 'queued', attempts: 0 });
  });
});

describe('driver reporting', () => {
  it('reports the in-process driver by default and never claims Redis support', () => {
    delete process.env.QUEUE_PROVIDER;
    delete process.env.REDIS_URL;
    expect(queueDriver()).toBe('inprocess');
    expect(queueInfo().redisConfigured).toBe(false);

    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.QUEUE_PROVIDER = 'redis';
    expect(queueDriver()).toBe('redis');
    delete process.env.QUEUE_PROVIDER;
    delete process.env.REDIS_URL;
  });
});
