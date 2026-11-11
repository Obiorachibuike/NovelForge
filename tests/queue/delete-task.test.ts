/**
 * Deleting tasks from the generation queue.
 *
 * Any state can be deleted: queued/processing tasks are cancelled first (the
 * worker then refuses to write their output) and the row plus its durable
 * events are removed. Cross-user deletion is impossible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDatabase, db, seedUser, seedNovel, seedOutline, seedChapter, jsonRequest, readJson } from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: 'Writer', email: 'writer@example.com' } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { enqueue, registerHandler, runJob, getJob, cancelJob, deleteJob } from '@/lib/queue';
import { deleteGeneration, getGenerationForUser } from '@/lib/jobs/generation-jobs';
import { listGenerationEvents } from '@/lib/jobs/events';
import {
  DELETE as deleteGenerationRoute,
  GET as getGenerationRoute,
} from '@/app/api/generations/[jobId]/route';

beforeEach(() => {
  freshDatabase();
  session.userId = null;
});

describe('deleteJob (queue primitive)', () => {
  it('deletes a queued job together with its durable events', async () => {
    const user = seedUser();
    const novel = seedNovel(user.id);
    seedOutline(novel.id, 1);
    const chapterId = seedChapter(novel.id, { chapterNumber: 1 });
    // Chapter jobs publish lifecycle events, so the durable event log is
    // non-empty before the delete and empty afterwards.
    const id = await enqueue({
      type: 'chapter', userId: user.id, novelId: novel.id, chapterId, payload: { chapterNumber: 1 },
    });
    expect(listGenerationEvents(id).length).toBeGreaterThan(0);

    expect(deleteJob(id)).toBe(true);
    expect(await getJob(id)).toBeUndefined();
    expect(listGenerationEvents(id)).toHaveLength(0);
  });

  it('deletes a completed job and its history', async () => {
    const user = seedUser();
    const novel = seedNovel(user.id);
    registerHandler('test-delete-done', async () => ({ ok: true }));
    const id = await enqueue({ type: 'test-delete-done', userId: user.id, novelId: novel.id, payload: {} });
    await runJob(id);
    expect((await getJob(id))?.status).toBe('completed');

    expect(deleteJob(id)).toBe(true);
    expect(await getJob(id)).toBeUndefined();
  });

  it('cancels a queued chapter job before removing it, preserving chapter content', async () => {
    const user = seedUser();
    const novel = seedNovel(user.id);
    seedOutline(novel.id, 1);
    const chapterId = seedChapter(novel.id, { chapterNumber: 1, status: 'generated', plainText: 'Existing prose.' });

    const id = await enqueue({
      type: 'chapter', userId: user.id, novelId: novel.id, chapterId, payload: { chapterNumber: 1 },
    });
    expect(deleteJob(id)).toBe(true);
    expect(await getJob(id)).toBeUndefined();

    const chapter = db().prepare('SELECT plainText, generationStatus FROM chapters WHERE id=?').get(chapterId) as any;
    expect(chapter.plainText).toBe('Existing prose.');
    expect(chapter.generationStatus).toBe('CANCELLED');
  });

  it('returns false for a job that does not exist', () => {
    expect(deleteJob('missing-job')).toBe(false);
  });

  it('deleting a job mid-processing makes the worker observe cancellation and never store the result', async () => {
    const user = seedUser();
    const novel = seedNovel(user.id);
    let release!: () => void;
    const started = new Promise<void>(resolve => {
      registerHandler('test-delete-processing', async () => {
        resolve();
        // Simulates a slow provider call: finishes AFTER the delete.
        await new Promise<void>(r => { release = r; });
        return { text: 'content that must never be persisted' };
      });
    });
    const id = await enqueue({ type: 'test-delete-processing', userId: user.id, novelId: novel.id, payload: {} });
    const run = runJob(id, 'w1');
    await started;
    expect((await getJob(id))?.status).toBe('processing');

    expect(deleteJob(id)).toBe(true);
    release();
    const result = await run;
    // The worker's completion is refused: the job vanished under it.
    expect(result.status).toBe('cancelled');
    expect(await getJob(id)).toBeUndefined();
    const row = db().prepare('SELECT result FROM generation_jobs WHERE id=?').get(id) as any;
    expect(row).toBeUndefined();
  });

  it('an already-cancelled job can still be deleted', async () => {
    const user = seedUser();
    const novel = seedNovel(user.id);
    registerHandler('test-delete-cancelled', async () => ({ ok: true }));
    const id = await enqueue({ type: 'test-delete-cancelled', userId: user.id, novelId: novel.id, payload: {} });
    expect(cancelJob(id)).toBe(true);
    expect(deleteJob(id)).toBe(true);
    expect(await getJob(id)).toBeUndefined();
  });
});

describe('DELETE /api/generations/[jobId]', () => {
  it('lets the owner delete a queued task and reports whether it was active', async () => {
    const user = seedUser();
    const novel = seedNovel(user.id);
    session.userId = user.id;
    registerHandler('test-route-delete', async () => ({ ok: true }));
    const id = await enqueue({ type: 'test-route-delete', userId: user.id, novelId: novel.id, payload: {} });

    const res = await deleteGenerationRoute(
      jsonRequest(`/api/generations/${id}`, undefined, { method: 'DELETE' }),
      { params: { jobId: id } },
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.wasActive).toBe(true);
    expect(await getJob(id)).toBeUndefined();

    // The list endpoint no longer shows it either.
    const detail = await getGenerationRoute(
      jsonRequest(`/api/generations/${id}`),
      { params: { jobId: id } },
    );
    expect(detail.status).toBe(404);
  });

  it('deletes finished tasks from history too', async () => {
    const user = seedUser();
    const novel = seedNovel(user.id);
    session.userId = user.id;
    registerHandler('test-route-delete-done', async () => ({ ok: true }));
    const id = await enqueue({ type: 'test-route-delete-done', userId: user.id, novelId: novel.id, payload: {} });
    await runJob(id);

    const res = await deleteGenerationRoute(
      jsonRequest(`/api/generations/${id}`, undefined, { method: 'DELETE' }),
      { params: { jobId: id } },
    );
    const body = await readJson(res);
    expect(body.wasActive).toBe(false);
    expect(await getJob(id)).toBeUndefined();
  });

  it('never deletes another user\'s task', async () => {
    const alice = seedUser();
    const bob = seedUser({ email: 'bob@example.com' });
    const novel = seedNovel(alice.id);
    session.userId = bob.id;
    registerHandler('test-route-delete-cross', async () => ({ ok: true }));
    const id = await enqueue({ type: 'test-route-delete-cross', userId: alice.id, novelId: novel.id, payload: {} });

    const res = await deleteGenerationRoute(
      jsonRequest(`/api/generations/${id}`, undefined, { method: 'DELETE' }),
      { params: { jobId: id } },
    );
    expect(res.status).toBe(404);
    expect(await getJob(id)).toBeDefined();
  });

  it('requires authentication', async () => {
    const user = seedUser();
    const novel = seedNovel(user.id);
    session.userId = null;
    registerHandler('test-route-delete-auth', async () => ({ ok: true }));
    const id = await enqueue({ type: 'test-route-delete-auth', userId: user.id, novelId: novel.id, payload: {} });

    const res = await deleteGenerationRoute(
      jsonRequest(`/api/generations/${id}`, undefined, { method: 'DELETE' }),
      { params: { jobId: id } },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await getJob(id)).toBeDefined();
  });
});

describe('deleteGeneration (service)', () => {
  it('reports a deleted active job as wasActive and a missing job as 404', async () => {
    const user = seedUser();
    const novel = seedNovel(user.id);
    registerHandler('test-service-delete', async () => ({ ok: true }));
    const id = await enqueue({ type: 'test-service-delete', userId: user.id, novelId: novel.id, payload: {} });

    const result = await deleteGeneration(user.id, id);
    expect(result).toEqual({ id, deleted: true, wasActive: true });
    expect(getGenerationForUser(user.id, id)).toBeUndefined();
    await expect(deleteGeneration(user.id, id)).rejects.toMatchObject({ status: 404 });
  });
});
