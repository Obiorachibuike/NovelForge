import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  freshDatabase,
  db,
  seedUser,
  seedNovel,
  seedOutline,
  seedChapter,
  reopenDatabase,
} from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: 'Writer', email: 'writer@example.com' } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import {
  enqueue,
  runJob,
  getJob,
  cancelJob,
  retryJob,
  registerHandler,
  serializeJob,
} from '@/lib/queue';
import { listGenerationEvents } from '@/lib/jobs/events';
import { listNotifications, notifyGenerationEvent, markNotificationRead } from '@/lib/jobs/notifications';
import {
  serializeGeneration,
  getGenerationForUser,
  listGenerations,
  maxActiveGenerationsPerUser,
} from '@/lib/jobs/generation-jobs';
import { GenerationStage } from '@/lib/jobs/job-types';
import { getNavigation } from '@/services/chapters/service';
import {
  __setBossForTests,
  sendChapterGeneration,
  startChapterGenerationWorker,
  stopBoss,
  type BossLike,
} from '@/lib/jobs/boss';
import { CHAPTER_GENERATION_QUEUE } from '@/lib/jobs/queues';
import { startWorker } from '@/lib/jobs/worker';

let user: { id: string; email: string; name: string };
let novel: { id: string; userId: string };
let chapterId: string;

beforeEach(() => {
  freshDatabase();
  user = seedUser();
  novel = seedNovel(user.id, { targetChapters: 3 });
  seedOutline(novel.id, 3);
  chapterId = seedChapter(novel.id, { chapterNumber: 1, status: 'draft', plainText: '' });
  session.userId = user.id;
  delete process.env.GENERATION_CANCEL_POLL_MS;
  delete process.env.QUEUE_PROVIDER;
  delete process.env.QUEUE_DISABLE_PG_BOSS;
});

afterEach(() => {
  __setBossForTests(null);
  delete process.env.GENERATION_CANCEL_POLL_MS;
  delete process.env.QUEUE_PROVIDER;
  delete process.env.QUEUE_DISABLE_PG_BOSS;
});

function chapterJob(overrides: { maxAttempts?: number } = {}) {
  return enqueue({
    type: 'chapter',
    userId: user.id,
    novelId: novel.id,
    chapterId,
    payload: { chapterNumber: 1 },
    idempotencyKey: `chapter:${novel.id}:1`,
    ...overrides,
  });
}

function chapterStatus(): string {
  return (db().prepare('SELECT generationStatus FROM chapters WHERE id=?').get(chapterId) as any).generationStatus;
}

describe('background generation lifecycle', () => {
  it('persists QUEUED → PROCESSING → COMPLETED, with real stages and events', async () => {
    registerHandler('chapter', async ctx => {
      ctx.setStage(GenerationStage.LOADING_NOVEL_CONTEXT);
      ctx.setStage(GenerationStage.GENERATING_CHAPTER_CONTENT);
      return { chapterId, chapterNumber: 1, wordCount: 120 };
    });

    const id = await chapterJob();
    expect(chapterStatus()).toBe('QUEUED');
    expect((await getJob(id))?.status).toBe('queued');

    const result = await runJob(id, 'test-worker');
    expect(result.status).toBe('completed');

    const job = await getJob(id);
    expect(job?.status).toBe('completed');
    expect(job?.currentStage).toBe('COMPLETED');
    expect(chapterStatus()).toBe('COMPLETED');

    const events = listGenerationEvents(id);
    expect(events.map(e => e.type)).toEqual([
      'generation_queued',
      'generation_started',
      'generation_progress',
      'generation_progress',
      'generation_completed',
    ]);
    const stages = events.filter(e => e.type === 'generation_progress').map(e => e.stage);
    expect(stages).toContain('LOADING_NOVEL_CONTEXT');
    expect(stages).toContain('GENERATING_CHAPTER_CONTENT');

    const generation = getGenerationForUser(user.id, id)!;
    const serialized = serializeGeneration(generation);
    expect(serialized.status).toBe('COMPLETED');
    // Providers expose no real percentage: chapter progress stays indeterminate.
    expect(serialized.progressPercentage).toBeNull();
    expect(serialized.indeterminate).toBe(false);
    expect(serialized.currentStageLabel).toBe('Completed');

    const notifications = listNotifications(user.id);
    expect(notifications.some(n => n.kind === 'generation_started')).toBe(true);
    expect(notifications.some(n => n.kind === 'generation_completed')).toBe(true);
  });

  it('prevents duplicate active jobs for the same chapter', async () => {
    registerHandler('chapter', async () => ({ chapterId }));
    const [a, b] = await Promise.all([chapterJob(), chapterJob()]);
    expect(a).toBe(b);
    expect(db().prepare('SELECT COUNT(*) AS c FROM generation_jobs').get()).toEqual({ c: 1 });
  });

  it('records a failure once, marks the chapter FAILED, and notifies', async () => {
    registerHandler('chapter', async () => {
      throw new Error('Provider timeout');
    });
    const id = await chapterJob({ maxAttempts: 1 });
    const result = await runJob(id);
    expect(result.status).toBe('failed');

    const job = await getJob(id);
    expect(job?.status).toBe('failed');
    expect(job?.errorCode).toBe('transient_error');
    expect(chapterStatus()).toBe('FAILED');

    const events = listGenerationEvents(id);
    expect(events.at(-1)?.type).toBe('generation_failed');
    const failedNotifications = listNotifications(user.id).filter(n => n.kind === 'generation_failed');
    expect(failedNotifications).toHaveLength(1);
  });

  it('retries a failed job without duplicating the chapter or the notification', async () => {
    registerHandler('chapter', async () => {
      throw new Error('Network failure');
    });
    const id = await chapterJob({ maxAttempts: 1 });
    await runJob(id);
    expect(chapterStatus()).toBe('FAILED');

    registerHandler('chapter', async () => ({ chapterId, chapterNumber: 1 }));
    expect(await retryJob(id)).toBe(true);
    expect((await getJob(id))?.status).toBe('queued');
    expect(chapterStatus()).toBe('QUEUED');

    const result = await runJob(id);
    expect(result.status).toBe('completed');
    expect(chapterStatus()).toBe('COMPLETED');
    expect(db().prepare('SELECT COUNT(*) AS c FROM chapters').get()).toEqual({ c: 1 });

    const completed = listNotifications(user.id).filter(n => n.kind === 'generation_completed');
    expect(completed).toHaveLength(1);
  });

  it('refuses to retry when a newer generation is already active for the chapter', async () => {
    registerHandler('chapter', async () => {
      throw new Error('Network failure');
    });
    const id = await chapterJob({ maxAttempts: 1 });
    await runJob(id);
    expect((await getJob(id))?.status).toBe('failed');

    // A fresh job for the same chapter exists and is active.
    registerHandler('chapter', async () => ({ ok: true }));
    const newer = await enqueue({
      type: 'chapter',
      userId: user.id,
      novelId: novel.id,
      chapterId,
      payload: { chapterNumber: 1 },
      idempotencyKey: `chapter:${novel.id}:1`,
    });
    expect(newer).not.toBe(id);
    expect(await retryJob(id)).toBe(false);
  });

  it('cancels an in-flight job safely and preserves existing chapter prose', async () => {
    process.env.GENERATION_CANCEL_POLL_MS = '25';
    const originalProse = 'Existing author prose that must survive cancellation.';
    db().prepare('UPDATE chapters SET plainText=?, status=? WHERE id=?').run(originalProse, 'edited', chapterId);

    let startedResolve: () => void = () => {};
    const started = new Promise<void>(resolve => { startedResolve = resolve; });
    registerHandler('chapter', async ctx => {
      startedResolve();
      while (!ctx.isCancelled()) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Generation was cancelled before completion.');
    });

    const id = await chapterJob();
    const running = runJob(id);
    await started;
    expect(cancelJob(id)).toBe(true);
    const result = await running;
    expect(result.status).toBe('cancelled');

    const job = await getJob(id);
    expect(job?.status).toBe('cancelled');
    expect(chapterStatus()).toBe('CANCELLED');
    expect((db().prepare('SELECT plainText FROM chapters WHERE id=?').get(chapterId) as any).plainText).toBe(originalProse);

    expect(listGenerationEvents(id).some(e => e.type === 'generation_cancelled')).toBe(true);
    expect(listNotifications(user.id).some(n => n.kind === 'generation_cancelled')).toBe(true);
    // A completed job can never be cancelled.
    expect(cancelJob(id)).toBe(false);
  });

  it('does not fabricate progress percentages for chapter jobs', async () => {
    let observed: number | null = 123;
    registerHandler('chapter', async ctx => {
      ctx.setProgress(75);
      observed = (db().prepare('SELECT progressPercentage FROM generation_jobs WHERE id=?').get(ctx.id) as any).progressPercentage;
      return { chapterId };
    });
    const id = await chapterJob();
    await runJob(id);
    expect(observed).toBeNull();
    expect((await getJob(id))?.progressPercentage).toBeNull();
  });

  it('exposes generation status in the chapter navigation', async () => {
    registerHandler('chapter', async () => ({ chapterId, chapterNumber: 1 }));
    const id = await chapterJob();
    let nav = await getNavigation(novel.id);
    expect(nav[0].generationStatus).toBe('QUEUED');
    await runJob(id);
    nav = await getNavigation(novel.id);
    expect(nav[0].generationStatus).toBe('COMPLETED');
    expect(nav[1].generationStatus).toBe('NOT_STARTED');
  });
});

describe('generation service', () => {
  it('lists only the caller’s own generations', () => {
    const other = seedUser();
    const otherNovel = seedNovel(other.id);
    seedOutline(otherNovel.id, 1);
    const now = new Date().toISOString();
    db().prepare(
      `INSERT INTO generation_jobs (id,userId,novelId,taskType,payload,status,attempts,maxAttempts,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('other-job', other.id, otherNovel.id, 'chapter', '{}', 'processing', 1, 3, now, now);

    expect(listGenerations(user.id)).toHaveLength(0);
    expect(listGenerations(other.id).map(g => g.id)).toEqual(['other-job']);
    expect(getGenerationForUser(user.id, 'other-job')).toBeUndefined();
    expect(maxActiveGenerationsPerUser()).toBeGreaterThan(0);
  });

  it('serialises honest status and stage labels', async () => {
    registerHandler('chapter', async () => ({ chapterId }));
    const id = await chapterJob();
    const row = getGenerationForUser(user.id, id)!;
    const serialized = serializeGeneration(row);
    expect(serialized.status).toBe('QUEUED');
    expect(serialized.indeterminate).toBe(true);
    expect(serialized.progressPercentage).toBeNull();
    expect(serialized.canCancel).toBe(true);
    expect(serialized.eventsUrl).toBe(`/api/generations/${id}/events`);
    // The legacy serialiser agrees on the public status.
    expect(serializeJob((await getJob(id))!).publicStatus).toBe('QUEUED');
  });

  it('deduplicates notifications created for the same attempt', async () => {
    registerHandler('chapter', async () => ({ chapterId }));
    const id = await chapterJob();
    const job = (await getJob(id))!;
    expect(notifyGenerationEvent(job, 'generation_completed')).toBe(true);
    expect(notifyGenerationEvent(job, 'generation_completed')).toBe(false);
    const notification = listNotifications(user.id).find(n => n.kind === 'generation_completed')!;
    expect(markNotificationRead(user.id, notification.id)).toBe(true);
    expect(markNotificationRead(seedUser().id, notification.id)).toBe(false);
  });
});

describe('persistence, reconnection and the dedicated worker', () => {
  it('restores active jobs, stage and events after a process restart', async () => {
    registerHandler('chapter', async ctx => {
      ctx.setStage(GenerationStage.GENERATING_CHAPTER_CONTENT);
      return { chapterId, chapterNumber: 1 };
    });
    const id = await chapterJob();
    expect((await getJob(id))?.status).toBe('queued');

    // Simulates closing and reopening NovelForge (worker + app restart): the
    // durable rows are the only state that matters.
    reopenDatabase();
    const restored = getGenerationForUser(user.id, id);
    expect(restored).toBeTruthy();
    expect(serializeGeneration(restored!).status).toBe('QUEUED');
    expect(listGenerationEvents(id).map(e => e.type)).toEqual(['generation_queued']);
    expect(chapterStatus()).toBe('QUEUED');

    await runJob(id);
    expect(serializeGeneration(getGenerationForUser(user.id, id)!).status).toBe('COMPLETED');
  });

  it('drains due work in the dedicated worker and shuts down gracefully', async () => {
    registerHandler('test-worker-job', async () => ({ ok: true }));
    const id = await enqueue({
      type: 'test-worker-job',
      userId: user.id,
      novelId: novel.id,
      payload: {},
    });

    const worker = await startWorker({
      registerPgBoss: false,
      pollMs: 40,
      concurrency: 1,
      log: () => {},
    });
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && (await getJob(id))?.status === 'queued') {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect((await getJob(id))?.status).toBe('completed');
    } finally {
      await worker.stop('test');
    }
  });
});

class FakeBoss implements BossLike {
  started = false;
  stopped = false;
  queueCreated: string | null = null;
  sent: Array<{ name: string; data: object | null; options?: Record<string, unknown> }> = [];
  workCalls: Array<{ name: string; options: Record<string, unknown>; handler: (jobs: any[]) => Promise<unknown> }> = [];

  async start() { this.started = true; return this; }
  async createQueue(name: string) { this.queueCreated = name; }
  async send(name: string, data: object | null, options?: Record<string, unknown>) {
    this.sent.push({ name, data, options });
    return 'pgboss-job-1';
  }
  async work(name: string, options: Record<string, unknown>, handler: (jobs: any[]) => Promise<unknown>) {
    this.workCalls.push({ name, options, handler });
    return 'worker-1';
  }
  async stop() { this.stopped = true; }
}

describe('pg-boss transport', () => {
  it('sends only the durable job id, with a singleton key for duplicate prevention', async () => {
    const fake = new FakeBoss();
    __setBossForTests(fake);
    const originalUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/novelforge';
    try {
      registerHandler('chapter', async () => ({ chapterId }));
      const id = await chapterJob();
      expect(fake.started).toBe(true);
      expect(fake.queueCreated).toBe(CHAPTER_GENERATION_QUEUE);
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0].name).toBe(CHAPTER_GENERATION_QUEUE);
      expect(fake.sent[0].data).toEqual({ dbJobId: id });
      expect(fake.sent[0].options?.singletonKey).toBe(`chapter-generation:${id}`);
      expect((await getJob(id))?.queueJobId).toBe('pgboss-job-1');
    } finally {
      process.env.DATABASE_URL = originalUrl;
    }
  });

  it('registers a consumer that runs the claimed job exactly once', async () => {
    const fake = new FakeBoss();
    __setBossForTests(fake);
    const originalUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/novelforge';
    try {
      registerHandler('chapter', async () => ({ chapterId }));
      const id = await chapterJob();
      const registration = await startChapterGenerationWorker((jobId, workerId) => runJob(jobId, workerId), {
        concurrency: 2,
        workerId: 'pgboss-test',
      });
      expect(registration).toBe('worker-1');
      expect(fake.workCalls[0].name).toBe(CHAPTER_GENERATION_QUEUE);
      expect(fake.workCalls[0].options.localConcurrency).toBe(2);

      await fake.workCalls[0].handler([{ id: 'p1', data: { dbJobId: id } }]);
      expect((await getJob(id))?.status).toBe('completed');
      // A redelivery of the same queue message cannot run the job again.
      await fake.workCalls[0].handler([{ id: 'p2', data: { dbJobId: id } }]);
      expect((await getJob(id))?.status).toBe('completed');
      expect((db().prepare('SELECT COUNT(*) AS c FROM generation_events WHERE type=?').get('generation_completed'))).toEqual({ c: 1 });
    } finally {
      process.env.DATABASE_URL = originalUrl;
      await stopBoss();
    }
  });

  it('falls back to the database transport when pg-boss is unavailable', async () => {
    const originalUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/novelforge';
    process.env.QUEUE_PROVIDER = 'database';
    try {
      // No fake boss: sendChapterGeneration must not attempt a connection.
      await expect(sendChapterGeneration('job-x')).resolves.toBeNull();
    } finally {
      process.env.QUEUE_PROVIDER = 'database';
      process.env.DATABASE_URL = originalUrl;
      delete process.env.QUEUE_PROVIDER;
    }
  });
});
