import { describe, expect, it, beforeEach, vi } from 'vitest';
import { freshDatabase, seedUser, seedNovel, seedOutline, seedChapter, db } from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { POST as editorAction } from '@/app/api/ai/editor-action/route';
import { RATE_LIMITS, resetRateLimitsForTests } from '@/lib/security/rate-limit';

function request(body: unknown) {
  return new Request('http://localhost:3000/api/ai/editor-action', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

let user: { id: string; email: string; name: string };
let novel: { id: string; userId: string };
let chapterId: string;

beforeEach(() => {
  freshDatabase();
  resetRateLimitsForTests();
  user = seedUser();
  novel = seedNovel(user.id);
  seedOutline(novel.id, 1);
  chapterId = seedChapter(novel.id, { chapterNumber: 1, status: 'generated' });
  session.userId = user.id;
});

describe('AI editor action', () => {
  it('runs in demo mode and labels the response source', async () => {
    const res = await editorAction(request({ action: 'continue', chapterId, selection: 'The rain had stopped.' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('demo');
    expect(typeof body.text).toBe('string');
    expect(body.text.length).toBeGreaterThan(0);
    // Demo output must not be recorded as paid usage.
    const usage = db().prepare(`SELECT * FROM ai_usage WHERE taskType=?`).get('editor:continue') as any;
    expect(usage).toBeUndefined();
  });

  it('rejects an unknown chapter id', async () => {
    const res = await editorAction(request({ action: 'continue', chapterId: 'nope', selection: '' }));
    expect(res.status).toBe(404);
  });

  it('refuses to rewrite an approved chapter', async () => {
    db().prepare(`UPDATE chapters SET status='approved' WHERE id=?`).run(chapterId);
    const res = await editorAction(request({ action: 'rewrite', chapterId, selection: 'Some sentence.' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('chapter_approved');
  });

  it('validates input and returns 400 (not 500) for a malformed payload', async () => {
    const res = await editorAction(request({ action: 'not-an-action', chapterId }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('validation_failed');
  });

  it('rejects oversized selections before any provider work', async () => {
    const res = await editorAction(request({ action: 'continue', chapterId, selection: 'x'.repeat(20000) }));
    expect(res.status).toBe(400);
  });

  it('rejects request bodies above the endpoint limit', async () => {
    const huge = { action: 'continue', chapterId, selection: 'pad', filler: 'y'.repeat(70 * 1024) };
    const res = await editorAction(request(huge));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('payload_too_large');
  });

  it('rate limits repeated editor actions per user', async () => {
    const original = RATE_LIMITS.aiEditor.limit;
    (RATE_LIMITS as any).aiEditor.limit = 2;
    try {
      expect((await editorAction(request({ action: 'continue', chapterId }))).status).toBe(200);
      expect((await editorAction(request({ action: 'continue', chapterId }))).status).toBe(200);
      const third = await editorAction(request({ action: 'continue', chapterId }));
      expect(third.status).toBe(429);
      expect((await third.json()).code).toBe('rate_limited');
    } finally {
      (RATE_LIMITS as any).aiEditor.limit = original;
      resetRateLimitsForTests();
    }
  });

  it('does not leak another user\'s chapter title in an error', async () => {
    const other = seedUser({ name: 'Other' });
    const otherNovel = seedNovel(other.id, { title: 'Other Novel' });
    seedOutline(otherNovel.id, 1);
    const otherChapter = seedChapter(otherNovel.id, { chapterNumber: 1 });
    const res = await editorAction(request({ action: 'continue', chapterId: otherChapter }));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('Other Novel');
  });
});
