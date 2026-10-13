import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { freshDatabase, seedUser, seedNovel, seedOutline, seedChapter, db, jsonRequest, readJson } from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { POST as enqueueChapterRoute, GET as listChaptersRoute } from '@/app/api/novels/[id]/chapters/route';
import { PATCH as saveChapterRoute } from '@/app/api/novels/[id]/chapters/[chapterId]/route';
import { POST as approveChapterRoute } from '@/app/api/novels/[id]/chapters/[chapterId]/approve/route';
import { enqueueChapterGeneration, getNavigation } from '@/services/chapters/service';
import { drainQueue, getJob } from '@/lib/queue';
import { resetOpenAIForTests } from '@/lib/ai/provider';

let user: { id: string; email: string; name: string };
let novel: { id: string; userId: string };

beforeEach(() => {
  freshDatabase();
  user = seedUser();
  novel = seedNovel(user.id, { targetChapters: 3 });
  seedOutline(novel.id, 3);
  session.userId = user.id;
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  process.env.AI_DEMO_MODE = 'true';
  resetOpenAIForTests();
});

/** Runs every queued job to completion. */
async function drain() {
  for (let i = 0; i < 12; i++) {
    const results = await drainQueue({ limit: 4, workerId: 'test-worker' });
    if (!results.length) break;
    const pending = db().prepare(`SELECT COUNT(*) AS c FROM generation_jobs WHERE status='queued'`).get() as any;
    if (!pending.c) break;
  }
}

describe('sequential writing gate', () => {
  it('refuses chapter 2 before chapter 1 is approved', async () => {
    const res = await enqueueChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 2 }, { method: 'POST' }), { params: { id: novel.id } });
    expect(res.status).toBe(409);
    expect((await readJson(res)).code).toBe('chapter_locked');
    expect((await readJson(await listChaptersRoute(jsonRequest(`/api/novels/${novel.id}/chapters`), { params: { id: novel.id } }))).length).toBe(0);
  });

  it('cannot generate a chapter outside the outline', async () => {
    const res = await enqueueChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 9 }, { method: 'POST' }), { params: { id: novel.id } });
    expect(res.status).toBe(404);
  });

  it('allows chapter 1, then blocks chapter 2 again until approval', async () => {
    const first = await enqueueChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 1 }, { method: 'POST' }), { params: { id: novel.id } });
    expect(first.status).toBe(200);
    const { jobId, chapterNumber } = await readJson(first);
    expect(chapterNumber).toBe(1);

    await drain();
    const job = await getJob(jobId);
    expect(job?.status).toBe('completed');

    const blocked = await enqueueChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 2 }, { method: 'POST' }), { params: { id: novel.id } });
    expect(blocked.status).toBe(409);
  });

  it('reports locked/next/generated/approved states from one implementation', async () => {
    let nav = await getNavigation(novel.id);
    expect(nav.map(n => n.status)).toEqual(['next', 'locked', 'locked']);

    await enqueueChapterGeneration(user.id, novel.id, 1);
    await drain();
    nav = await getNavigation(novel.id);
    expect(nav.map(n => n.status)).toEqual(['generated', 'locked', 'locked']);

    const chapterId = nav[0].chapterId!;
    await approveChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters/${chapterId}/approve`, {}, { method: 'POST' }), { params: { id: novel.id, chapterId } });
    nav = await getNavigation(novel.id);
    expect(nav.map(n => n.status)).toEqual(['approved', 'next', 'locked']);
  });
});

describe('generation', () => {
  it('saves demo output with an explicit generation source and a version snapshot', async () => {
    const res = await enqueueChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, {}, { method: 'POST' }), { params: { id: novel.id } });
    const { jobId } = await readJson(res);
    await drain();

    const job = await getJob(jobId);
    expect(job?.status).toBe('completed');
    const result = JSON.parse(job!.result!);
    expect(result.source).toBe('demo');
    expect(result.demo).toBe(true);

    const chapter = db().prepare('SELECT * FROM chapters WHERE novelId=?').get(novel.id) as any;
    expect(chapter.status).toBe('generated');
    expect(chapter.generationSource).toBe('demo');
    expect(chapter.wordCount).toBeGreaterThan(10);
    const version = db().prepare('SELECT * FROM chapter_versions WHERE chapterId=?').get(chapter.id) as any;
    expect(version.versionNum).toBe(1);
  });

  it('is idempotent for duplicate clicks', async () => {
    const first = await readJson(await enqueueChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, {}, { method: 'POST' }), { params: { id: novel.id } }));
    const second = await readJson(await enqueueChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, {}, { method: 'POST' }), { params: { id: novel.id } }));
    expect(second.jobId).toBe(first.jobId);
    expect(db().prepare(`SELECT COUNT(*) AS c FROM generation_jobs WHERE novelId=? AND taskType='chapter'`).get(novel.id)).toEqual({ c: 1 });
  });

  it('a failed real-provider call leaves the existing chapter untouched', async () => {
    seedChapter(novel.id, { chapterNumber: 1, status: 'edited', plainText: 'Author-written prose that must survive.' });
    // Force "real" mode with an unusable key: the provider call fails.
    process.env.OPENAI_API_KEY = 'sk-test-invalid-key';
    process.env.AI_DEMO_MODE = 'false';
    resetOpenAIForTests();

    const jobId = await enqueueChapterGeneration(user.id, novel.id, 1, { confirmOverwrite: true });
    await drain();

    // The failure is recorded and the job is rescheduled for a bounded retry;
    // it is never silently completed with substitute prose.
    const job = await getJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);
    expect(job?.error).toBeTruthy();
    expect(job?.error).not.toMatch(/demo/i);

    const chapter = db().prepare('SELECT plainText, status FROM chapters WHERE novelId=? AND chapterNumber=1').get(novel.id) as any;
    expect(chapter.plainText).toBe('Author-written prose that must survive.');
    expect(chapter.status).toBe('edited');
  });
});

describe('author control over existing prose', () => {
  it('version numbering continues instead of colliding', async () => {
    const chapterId = seedChapter(novel.id, { chapterNumber: 1, status: 'generated' });
    db().prepare(`INSERT INTO chapter_versions (id,chapterId,versionNum,contentJson,wordCount,note,createdAt) VALUES ('v1',?,1,'{}',10,'initial',?)`)
      .run(chapterId, new Date().toISOString());

    await enqueueChapterGeneration(user.id, novel.id, 1);
    await drain();

    const versions = db().prepare('SELECT versionNum FROM chapter_versions WHERE chapterId=? ORDER BY versionNum').all(chapterId) as any[];
    expect(versions.map(v => v.versionNum)).toEqual([1, 2]);
  });

  it('refuses to overwrite author edits without explicit confirmation', async () => {
    const chapterId = seedChapter(novel.id, { chapterNumber: 1, status: 'generated' });
    const save = await saveChapterRoute(
      jsonRequest(`/api/novels/${novel.id}/chapters/${chapterId}`, { contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'My own rewrite of this chapter, carefully worded.' }] }] } }, { method: 'PATCH' }),
      { params: { id: novel.id, chapterId } },
    );
    expect(save.status).toBe(200);
    expect(db().prepare('SELECT status, wordCount FROM chapters WHERE id=?').get(chapterId)).toMatchObject({ status: 'edited' });

    const refused = await enqueueChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 1 }, { method: 'POST' }), { params: { id: novel.id } });
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).code).toBe('overwrite_confirmation_required');

    const confirmed = await enqueueChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 1, confirmOverwrite: true }, { method: 'POST' }), { params: { id: novel.id } });
    expect(confirmed.status).toBe(200);
    await drain();
    const chapter = db().prepare('SELECT plainText, status FROM chapters WHERE id=?').get(chapterId) as any;
    expect(chapter.plainText).not.toContain('My own rewrite');
    expect(chapter.status).toBe('generated');
  });

  it('approved chapters are read-only and cannot be regenerated', async () => {
    const chapterId = seedChapter(novel.id, { chapterNumber: 1, status: 'approved', plainText: 'Approved prose.' });
    const save = await saveChapterRoute(
      jsonRequest(`/api/novels/${novel.id}/chapters/${chapterId}`, { contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'sneaky edit' }] }] } }, { method: 'PATCH' }),
      { params: { id: novel.id, chapterId } },
    );
    expect(save.status).toBe(409);
    expect((await readJson(save)).code).toBe('chapter_approved');

    const regenerate = await enqueueChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 1, confirmOverwrite: true }, { method: 'POST' }), { params: { id: novel.id } });
    expect(regenerate.status).toBe(409);
    expect((db().prepare('SELECT plainText FROM chapters WHERE id=?').get(chapterId) as any).plainText).toBe('Approved prose.');
  });

  it('rejects an empty chapter approval', async () => {
    const chapterId = seedChapter(novel.id, { chapterNumber: 1, status: 'generated', plainText: '' });
    const res = await approveChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters/${chapterId}/approve`, {}, { method: 'POST' }), { params: { id: novel.id, chapterId } });
    expect(res.status).toBe(409);
    expect((await readJson(res)).code).toBe('chapter_empty');
  });
});

describe('approval unlocks the next chapter and queued memory extraction', () => {
  it('approving chapter 1 unblocks chapter 2 and queues a durable memory job', async () => {
    await enqueueChapterGeneration(user.id, novel.id, 1);
    await drain();
    const chapter = db().prepare('SELECT id FROM chapters WHERE novelId=? AND chapterNumber=1').get(novel.id) as any;

    await approveChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters/${chapter.id}/approve`, {}, { method: 'POST' }), { params: { id: novel.id, chapterId: chapter.id } });

    const memoryJob = db().prepare(`SELECT * FROM generation_jobs WHERE idempotencyKey=?`).get(`memory:${chapter.id}`) as any;
    expect(memoryJob).toBeTruthy();

    await drain();
    const updated = db().prepare('SELECT summary, status FROM chapters WHERE id=?').get(chapter.id) as any;
    expect(updated.status).toBe('approved');
    expect(updated.summary).toBeTruthy();

    const nav = await getNavigation(novel.id);
    expect(nav[1].status).toBe('next');
    const second = await enqueueChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 2 }, { method: 'POST' }), { params: { id: novel.id } });
    expect(second.status).toBe(200);
  });

  it('resuming after a restart does not lose queued work', async () => {
    await enqueueChapterGeneration(user.id, novel.id, 1);
    // "Restart": the job row survives, the in-process dispatch does not.
    const { reopenDatabase } = await import('../helpers/db');
    reopenDatabase();
    const row = db().prepare('SELECT id FROM generation_jobs').get() as any;
    expect((await getJob(row.id))?.status).toBe('queued');
    await drain();
    expect(db().prepare('SELECT COUNT(*) AS c FROM chapters WHERE novelId=?').get(novel.id)).toEqual({ c: 1 });
  });
});
