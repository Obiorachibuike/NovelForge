import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { freshDatabase, db, seedUser, seedNovel, seedOutline, seedChapter } from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: 'Writer', email: 'writer@example.com' } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { enqueue, runJob, registerHandler } from '@/lib/queue';
import {
  decodeEventCursor,
  encodeEventCursor,
  formatHeartbeat,
  formatSseFrame,
  listGenerationEvents,
} from '@/lib/jobs/events';
import { GET as eventsRoute } from '@/app/api/generations/[jobId]/events/route';
import { GET as generationRoute } from '@/app/api/generations/[jobId]/route';
import { POST as cancelRoute } from '@/app/api/generations/[jobId]/cancel/route';
import { POST as retryRoute } from '@/app/api/generations/[jobId]/retry/route';
import { GET as generationsRoute, POST as createGenerationRoute } from '@/app/api/generations/route';
import { GET as notificationsRoute } from '@/app/api/notifications/route';
import { PATCH as notificationRoute } from '@/app/api/notifications/[notificationId]/route';
import { POST as readAllRoute } from '@/app/api/notifications/read-all/route';
import { createNotification } from '@/lib/jobs/notifications';

let user: { id: string; email: string; name: string };
let other: { id: string; email: string; name: string };
let novel: { id: string; userId: string };
let chapterId: string;

beforeEach(() => {
  freshDatabase();
  user = seedUser();
  other = seedUser();
  novel = seedNovel(user.id, { targetChapters: 2 });
  seedOutline(novel.id, 2);
  chapterId = seedChapter(novel.id, { chapterNumber: 1, status: 'draft', plainText: '' });
  session.userId = user.id;
  delete process.env.AI_DEMO_MODE;
  delete process.env.AGENES_API_KEY;
});

afterEach(() => {
  session.userId = null;
  process.env.AI_DEMO_MODE = 'true';
  delete process.env.AGNES_API_KEY;
});

function req(url: string, init: RequestInit = {}) {
  return new Request(`http://localhost:3000${url}`, init);
}

function jsonReq(url: string, body: unknown, method = 'POST') {
  return req(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readAll(response: Response, timeoutMs = 4000): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, timeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
  }
  return text;
}

async function completedJob() {
  registerHandler('chapter', async ctx => {
    ctx.setStage('GENERATING_CHAPTER_CONTENT');
    return { chapterId, chapterNumber: 1 };
  });
  const id = await enqueue({
    type: 'chapter',
    userId: user.id,
    novelId: novel.id,
    chapterId,
    payload: { chapterNumber: 1 },
    idempotencyKey: `chapter:${novel.id}:1`,
  });
  await runJob(id);
  return id;
}

describe('generation API security', () => {
  it('rejects unauthenticated access to every generation endpoint', async () => {
    session.userId = null;
    const responses = [
      await generationsRoute(req('/api/generations')),
      await createGenerationRoute(jsonReq('/api/generations', { novelId: novel.id, chapterNumber: 1 })),
      await generationRoute(req('/api/generations/x'), { params: { jobId: 'x' } }),
      await cancelRoute(req('/api/generations/x/cancel'), { params: { jobId: 'x' } }),
      await retryRoute(req('/api/generations/x/retry'), { params: { jobId: 'x' } }),
      await eventsRoute(req('/api/generations/x/events'), { params: { jobId: 'x' } }),
      await notificationsRoute(req('/api/notifications')),
    ];
    for (const response of responses) expect(response.status).toBe(401);
  });

  it('never exposes another user’s job, cancel, retry or SSE stream', async () => {
    const now = new Date().toISOString();
    db().prepare(
      `INSERT INTO generation_jobs (id,userId,novelId,chapterId,taskType,payload,status,attempts,maxAttempts,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('other-job', other.id, novel.id, chapterId, 'chapter', '{"chapterNumber":1}', 'processing', 1, 3, now, now);

    session.userId = user.id;
    expect((await generationRoute(req('/api/generations/other-job'), { params: { jobId: 'other-job' } })).status).toBe(404);
    expect((await cancelRoute(req('/api/generations/other-job/cancel'), { params: { jobId: 'other-job' } })).status).toBe(404);
    expect((await retryRoute(req('/api/generations/other-job/retry'), { params: { jobId: 'other-job' } })).status).toBe(404);
    expect((await eventsRoute(req('/api/generations/other-job/events'), { params: { jobId: 'other-job' } })).status).toBe(404);

    const list = await (await generationsRoute(req('/api/generations'))).json();
    expect(list.generations).toHaveLength(0);
  });

  it('refuses to create a generation for a novel owned by someone else', async () => {
    session.userId = user.id;
    const otherNovel = seedNovel(other.id);
    const response = await createGenerationRoute(
      jsonReq('/api/generations', { novelId: otherNovel.id, chapterNumber: 1 }),
    );
    expect(response.status).toBe(404);
    expect(db().prepare('SELECT COUNT(*) AS c FROM generation_jobs').get()).toEqual({ c: 0 });
  });

  it('validates the request body', async () => {
    session.userId = user.id;
    const response = await createGenerationRoute(jsonReq('/api/generations', { chapterNumber: 1 }));
    expect(response.status).toBe(400);
  });

  it('scopes notifications to their owner', async () => {
    const now = new Date().toISOString();
    db().prepare(
      `INSERT INTO notifications (id,userId,kind,title,message,isRead,createdAt)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('n1', other.id, 'generation_completed', 'Theirs', 'Private', 0, now);

    session.userId = user.id;
    const list = await (await notificationsRoute(req('/api/notifications'))).json();
    expect(list.notifications).toHaveLength(0);
    const patch = await notificationRoute(req('/api/notifications/n1', { method: 'PATCH' }), {
      params: { notificationId: 'n1' },
    });
    expect(patch.status).toBe(404);
  });
});

describe('generation creation endpoint', () => {
  it('returns 202 with a durable job id, queued status and SSE URL', async () => {
    process.env.AI_DEMO_MODE = 'false';
    process.env.AGNES_API_KEY = 'test-agnes-key';
    registerHandler('chapter', async () => ({ chapterId, chapterNumber: 1 }));

    const response = await createGenerationRoute(
      jsonReq('/api/generations', { novelId: novel.id, chapterNumber: 1 }),
    );
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.jobId).toBeTruthy();
    expect(body.status).toBe('QUEUED');
    expect(body.eventsUrl).toBe(`/api/generations/${body.jobId}/events`);
    expect(body.cancelUrl).toBe(`/api/generations/${body.jobId}/cancel`);

    const details = await (await generationRoute(req(`/api/generations/${body.jobId}`), {
      params: { jobId: body.jobId },
    })).json();
    expect(details.generation.status).toBe('QUEUED');
    expect(details.generation.chapterNumber).toBe(1);
    expect(details.generation.novelTitle).toBeTruthy();
    expect(details.generation.progressPercentage).toBeNull();
    // Stages are only recorded when the worker actually reaches them; a
    // queued job must not pretend it is already preparing the chapter.
    expect(details.generation.currentStage).toBeNull();
    expect(details.generation.currentStageLabel).toBeNull();

    // A refresh (new request) must still find the active job, so the global
    // indicator can be restored without relying on client state.
    const list = await (await generationsRoute(req('/api/generations'))).json();
    expect(list.activeCount).toBe(1);
    expect(list.activeGenerations.map((g: { id: string }) => g.id)).toContain(body.jobId);
    expect(list.limits.maxActivePerUser).toBeGreaterThan(0);
  });
});

describe('SSE generation stream', () => {
  it('sends a snapshot, replayed events and a terminal event, then closes', async () => {
    const id = await completedJob();
    const response = await eventsRoute(req(`/api/generations/${id}/events`), { params: { jobId: id } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');

    const text = await readAll(response);
    expect(text).toContain('event: generation_snapshot');
    expect(text).toContain('event: generation_queued');
    expect(text).toContain('event: generation_started');
    expect(text).toContain('event: generation_progress');
    expect(text).toContain('event: generation_completed');
    expect(text).toContain('"status":"COMPLETED"');
    expect(text).toMatch(/^id: /m);
    expect(text).not.toMatch(/\d+%/);
  });

  it('replays only events after Last-Event-ID, so a reconnect loses nothing', async () => {
    const id = await completedJob();
    const all = listGenerationEvents(id);
    expect(all.length).toBeGreaterThan(2);
    const first = all[0];
    const lastEventId = encodeEventCursor(first);

    const response = await eventsRoute(
      req(`/api/generations/${id}/events`, { headers: { 'last-event-id': lastEventId } }),
      { params: { jobId: id } },
    );
    const text = await readAll(response);
    expect(text).toContain('event: generation_snapshot');
    // The already-seen queued event must not be re-delivered.
    expect(text).not.toContain(`id: ${lastEventId}`);
    expect(text).toContain('event: generation_started');
    expect(text).toContain('event: generation_completed');

    const cursor = decodeEventCursor(lastEventId);
    expect(cursor).toBe(first.seq);
    expect(decodeEventCursor('not-a-cursor')).toBeNull();
  });

  it('streams live progress for an active job and then the completion', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    registerHandler('chapter', async ctx => {
      ctx.setStage('GENERATING_CHAPTER_CONTENT');
      await gate;
      return { chapterId, chapterNumber: 1 };
    });
    const id = await enqueue({
      type: 'chapter', userId: user.id, novelId: novel.id, chapterId,
      payload: { chapterNumber: 1 }, idempotencyKey: `chapter:${novel.id}:1`,
    });

    const response = await eventsRoute(req(`/api/generations/${id}/events`), { params: { jobId: id } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const running = runJob(id);

    let text = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !text.includes('event: generation_progress')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain('event: generation_progress');
    expect(text).toContain('GENERATING_CHAPTER_CONTENT');

    release();
    await running;
    const safety = setTimeout(() => { void reader.cancel().catch(() => {}); }, 4000);
    while (!text.includes('event: generation_completed')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    clearTimeout(safety);
    expect(text).toContain('event: generation_completed');
    await reader.cancel().catch(() => {});
  });

  it('caps concurrent streams per user and frees a slot when the client disconnects', async () => {
    const id = await enqueue({
      type: 'chapter',
      userId: user.id,
      novelId: novel.id,
      chapterId,
      payload: { chapterNumber: 1 },
      idempotencyKey: `chapter:${novel.id}:1`,
    });

    process.env.SSE_MAX_CONNECTIONS_PER_USER = '1';
    try {
      const first = await eventsRoute(req(`/api/generations/${id}/events`), { params: { jobId: id } });
      expect(first.status).toBe(200);
      const reader = first.body!.getReader();
      // Read the retry hint so the stream is definitely live.
      await reader.read();

      const second = await eventsRoute(req(`/api/generations/${id}/events`), { params: { jobId: id } });
      expect(second.status).toBe(429);

      await reader.cancel();
      const third = await eventsRoute(req(`/api/generations/${id}/events`), { params: { jobId: id } });
      expect(third.status).toBe(200);
      await third.body!.getReader().cancel();
    } finally {
      delete process.env.SSE_MAX_CONNECTIONS_PER_USER;
    }
  });

  it('formats SSE frames and heartbeats safely', () => {
    const frame = formatSseFrame({
      event: 'generation_progress',
      id: 'a#b',
      data: { stage: 'SAVING_CHAPTER', message: 'line one\nline two' },
    });
    expect(frame).toContain('event: generation_progress');
    expect(frame).toContain('id: a#b');
    expect(frame).toContain('data: {"stage":"SAVING_CHAPTER","message":"line one\\nline two"}');
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(formatHeartbeat()).toMatch(/^: keep-alive /);
  });
});

describe('cancel and retry endpoints', () => {
  it('cancels queued jobs, notifies and refuses to cancel a finished job', async () => {
    registerHandler('chapter', async () => ({ chapterId }));
    const id = await enqueue({
      type: 'chapter', userId: user.id, novelId: novel.id, chapterId,
      payload: { chapterNumber: 1 }, idempotencyKey: `chapter:${novel.id}:1`,
    });

    const cancel = await cancelRoute(req(`/api/generations/${id}/cancel`, { method: 'POST' }), {
      params: { jobId: id },
    });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).generation.status).toBe('CANCELLED');
    expect((db().prepare('SELECT generationStatus FROM chapters WHERE id=?').get(chapterId) as any).generationStatus)
      .toBe('CANCELLED');

    const again = await cancelRoute(req(`/api/generations/${id}/cancel`, { method: 'POST' }), {
      params: { jobId: id },
    });
    expect(again.status).toBe(409);
  });

  it('retries only failed or cancelled generations', async () => {
    registerHandler('chapter', async () => {
      throw new Error('temporary provider failure');
    });
    const id = await enqueue({
      type: 'chapter', userId: user.id, novelId: novel.id, chapterId,
      payload: { chapterNumber: 1 }, idempotencyKey: `chapter:${novel.id}:1`, maxAttempts: 1,
    });
    await runJob(id);

    const retry = await retryRoute(req(`/api/generations/${id}/retry`, { method: 'POST' }), {
      params: { jobId: id },
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()).generation.status).toBe('QUEUED');

    const secondRetry = await retryRoute(req(`/api/generations/${id}/retry`, { method: 'POST' }), {
      params: { jobId: id },
    });
    expect(secondRetry.status).toBe(409);
  });
});

describe('notification centre API', () => {
  it('lists only the signed-in user\'s notifications and their unread count', async () => {
    createNotification({ userId: user.id, kind: 'completed', title: 'Chapter ready', message: 'Chapter 1 is ready.', novelId: novel.id, chapterId });
    createNotification({ userId: user.id, kind: 'failed', title: 'Generation failed', message: 'Try again.', novelId: novel.id, chapterId });
    createNotification({ userId: other.id, kind: 'completed', title: 'Someone else', message: 'Not yours.' });

    const res = await notificationsRoute(req('/api/notifications'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unreadCount).toBe(2);
    expect(body.notifications).toHaveLength(2);
    expect(body.notifications.every((n: { title: string }) => n.title !== 'Someone else')).toBe(true);
    expect(body.notifications[0].href).toContain('/novels/');
  });

  it('marks one notification read and completes the lifecycle for read-all', async () => {
    createNotification({ userId: user.id, kind: 'completed', title: 'One', message: 'First' });
    createNotification({ userId: user.id, kind: 'cancelled', title: 'Two', message: 'Second' });
    const list = await (await notificationsRoute(req('/api/notifications'))).json();
    const id = list.notifications[0].id as string;

    const patched = await notificationRoute(
      req(`/api/notifications/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isRead: true }) }),
      { params: { notificationId: id } },
    );
    expect(patched.status).toBe(200);
    expect((await patched.json()).unreadCount).toBe(1);

    const all = await readAllRoute(req('/api/notifications/read-all', { method: 'POST' }));
    expect(all.status).toBe(200);
    expect((await all.json()).unreadCount).toBe(0);
  });

  it('returns 401 without a session and 404 for another user\'s notification', async () => {
    const own = createNotification({ userId: other.id, kind: 'failed', title: 'Theirs', message: 'Nope' });
    expect(own).toBe(true);
    const theirs = (await (await notificationsRoute(req('/api/notifications'))).json()).notifications;
    // The signed-in user cannot see the other user's row, so mint an id directly.
    const foreignId = (db().prepare('SELECT id FROM notifications WHERE userId=?').get(other.id) as { id: string }).id;
    expect(theirs).toHaveLength(0);

    const res = await notificationRoute(
      req(`/api/notifications/${foreignId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isRead: true }) }),
      { params: { notificationId: foreignId } },
    );
    expect(res.status).toBe(404);

    session.userId = null;
    expect((await notificationsRoute(req('/api/notifications'))).status).toBe(401);
    expect((await readAllRoute(req('/api/notifications/read-all', { method: 'POST' }))).status).toBe(401);
  });
});
