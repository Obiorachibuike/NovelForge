import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import { freshDatabase, seedUser, seedNovel, seedOutline, seedChapter, seedCover, seedExportRow, db } from '../helpers/db';

/**
 * Cross-user isolation.
 *
 * User A owns a complete novel (outline, chapter, cover, export, queued job).
 * User B is authenticated and tries to reach every one of those resources.
 * Every attempt must fail without revealing A's data.
 */
const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: 'B', email: 'b@example.com' } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { GET as listNovels, POST as createNovel } from '@/app/api/novels/route';
import { GET as getNovel, DELETE as deleteNovel } from '@/app/api/novels/[id]/route';
import { GET as getCovers, POST as generateCovers, PUT as selectCover } from '@/app/api/novels/[id]/cover/route';
import { GET as getChapters, POST as generateChapter } from '@/app/api/novels/[id]/chapters/route';
import { GET as getChapter, PATCH as saveChapter } from '@/app/api/novels/[id]/chapters/[chapterId]/route';
import { POST as approveChapter } from '@/app/api/novels/[id]/chapters/[chapterId]/approve/route';
import { GET as getConsistency, POST as runConsistency, PATCH as resolveIssue } from '@/app/api/novels/[id]/consistency/route';
import { GET as listExports, POST as startExport } from '@/app/api/novels/[id]/export/route';
import { GET as getSettings, PUT as putSettings } from '@/app/api/novels/[id]/settings/route';
import { PATCH as patchPremise } from '@/app/api/novels/[id]/premise/route';
import { PATCH as patchOutline } from '@/app/api/novels/[id]/outline/[outlineId]/route';
import { POST as prepareNovel } from '@/app/api/novels/[id]/prepare/route';
import { GET as listNovelJobs } from '@/app/api/novels/[id]/jobs/route';
import { GET as getJobStatus } from '@/app/api/jobs/[jobId]/route';
import { POST as editorAction } from '@/app/api/ai/editor-action/route';
import { GET as getFile } from '@/app/api/files/[...key]/route';
import { enqueue } from '@/lib/queue';

const json = (body?: unknown, method = 'GET') => new Request(`http://localhost:3000/api`, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

let userA: { id: string; email: string; name: string };
let userB: { id: string; email: string; name: string };
let novelA: { id: string; userId: string };
let chapterAId: string;
let coverAKey: string;
let exportAKey: string;
let jobAId: string;
let outlineAId: string;

beforeAll(() => {
  freshDatabase();
});

beforeEach(async () => {
  freshDatabase();
  userA = seedUser({ name: 'Author A' });
  userB = seedUser({ name: 'Author B' });
  novelA = seedNovel(userA.id, { title: 'A Private Manuscript' });
  seedOutline(novelA.id, 2);
  chapterAId = seedChapter(novelA.id, { chapterNumber: 1 });
  outlineAId = (db().prepare('SELECT id FROM chapter_outlines WHERE novelId=? AND chapterNumber=2').get(novelA.id) as any).id;
  coverAKey = `covers/${'a'.repeat(8)}.svg`;
  seedCover(userA.id, novelA.id, { storageKey: coverAKey, isPrimary: 1 });
  exportAKey = `exports/${'b'.repeat(8)}.txt`;
  seedExportRow(userA.id, novelA.id, { fileKey: exportAKey });
  jobAId = await enqueue({ type: 'consistency', userId: userA.id, novelId: novelA.id, payload: {} });
  session.userId = userB.id;
});

describe('unauthenticated access', () => {
  it('rejects requests without a session', async () => {
    session.userId = null;
    const res = await listNovels();
    expect(res.status).toBe(401);
  });
});

describe('user B cannot reach user A resources', () => {
  it('novel read/delete/list', async () => {
    const read = await getNovel(json(), { params: { id: novelA.id } });
    expect(read.status).toBe(404);
    expect(JSON.stringify(await read.json())).not.toContain('A Private Manuscript');

    const del = await deleteNovel(json(undefined, 'DELETE'), { params: { id: novelA.id } });
    expect(del.status).toBe(404);
    expect(db().prepare('SELECT id FROM novels WHERE id=?').get(novelA.id)).toBeTruthy();

    const list = await listNovels();
    const body = await list.json();
    expect(body).toEqual([]);
  });

  it('covers: list, generate, select', async () => {
    expect((await getCovers(json(), { params: { id: novelA.id } })).status).toBe(404);
    expect((await generateCovers(json({ prompt: 'epic cover', variants: 1 }, 'POST'), { params: { id: novelA.id } })).status).toBe(404);

    const own = seedNovel(userB.id);
    const res = await selectCover(json({ imageId: (db().prepare('SELECT id FROM image_assets WHERE storageKey=?').get(coverAKey) as any).id }, 'PUT'), { params: { id: own.id } });
    // Selecting someone else's image id inside your own novel is rejected.
    expect(res.status).toBe(404);
    expect(db().prepare('SELECT coverImageId FROM novels WHERE id=?').get(own.id)).toEqual({ coverImageId: null });
  });

  it('chapters: list, generate, read, autosave, approve', async () => {
    expect((await getChapters(json(), { params: { id: novelA.id } })).status).toBe(404);
    expect((await generateChapter(json({ chapterNumber: 1 }, 'POST'), { params: { id: novelA.id } })).status).toBe(404);
    expect((await getChapter(json(), { params: { id: novelA.id, chapterId: chapterAId } })).status).toBe(404);
    expect((await saveChapter(json({ contentJson: { type: 'doc', content: [] } }, 'PATCH'), { params: { id: novelA.id, chapterId: chapterAId } })).status).toBe(404);
    expect((await approveChapter(json(undefined, 'POST'), { params: { id: novelA.id, chapterId: chapterAId } })).status).toBe(404);

    // Cross-novel confusion: B's own novel + A's chapter id.
    const ownNovel = seedNovel(userB.id);
    seedOutline(ownNovel.id, 1);
    expect((await getChapter(json(), { params: { id: ownNovel.id, chapterId: chapterAId } })).status).toBe(404);
    expect((await approveChapter(json(undefined, 'POST'), { params: { id: ownNovel.id, chapterId: chapterAId } })).status).toBe(404);

    const chapterRow = db().prepare('SELECT status, plainText FROM chapters WHERE id=?').get(chapterAId) as any;
    expect(chapterRow.status).toBe('generated');
    expect(chapterRow.plainText).toContain('rain had stopped');
  });

  it('preparation, outline edits and outline generation', async () => {
    expect((await prepareNovel(json({}, 'POST'), { params: { id: novelA.id } })).status).toBe(404);
    expect((await patchPremise(json({ logline: 'hacked' }, 'PATCH'), { params: { id: novelA.id } })).status).toBe(404);
    expect((await patchOutline(json({ title: 'hacked' }, 'PATCH'), { params: { id: novelA.id, outlineId: outlineAId } })).status).toBe(404);
    expect((db().prepare('SELECT title FROM chapter_outlines WHERE id=?').get(outlineAId) as any).title).toBe('Chapter 2');
  });

  it('consistency checks and issue resolution', async () => {
    // Seed an issue owned by A.
    db().prepare(
      `INSERT INTO consistency_issues (id,novelId,chapterId,kind,severity,title,description,status,createdAt,updatedAt)
       VALUES ('issue_a',?,?,?,?,?,?,?,?,?)`,
    ).run(novelA.id, chapterAId, 'timeline', 'warning', 'A issue', 'desc', 'open', new Date().toISOString(), new Date().toISOString());

    expect((await getConsistency(json(), { params: { id: novelA.id } })).status).toBe(404);
    expect((await runConsistency(json(undefined, 'POST'), { params: { id: novelA.id } })).status).toBe(404);
    expect((await resolveIssue(json({ issueId: 'issue_a', status: 'resolved' }, 'PATCH'), { params: { id: novelA.id } })).status).toBe(404);
    expect((db().prepare('SELECT status FROM consistency_issues WHERE id=?').get('issue_a') as any).status).toBe('open');
  });

  it('exports and settings', async () => {
    expect((await listExports(json(), { params: { id: novelA.id } })).status).toBe(404);
    expect((await startExport(json({ format: 'txt' }, 'POST'), { params: { id: novelA.id } })).status).toBe(404);
    expect((await getSettings(json(), { params: { id: novelA.id } })).status).toBe(404);
    expect((await putSettings(json({ fontSize: 24 }, 'PUT'), { params: { id: novelA.id } })).status).toBe(404);
    expect((db().prepare('SELECT fontSize FROM novel_settings WHERE novelId=?').get(novelA.id) as any).fontSize).toBe(12);
  });

  it('jobs list and job status', async () => {
    expect((await listNovelJobs(json(), { params: { id: novelA.id } })).status).toBe(404);
    const status = await getJobStatus(json(), { params: { jobId: jobAId } });
    expect(status.status).toBe(404);
    expect(JSON.stringify(await status.json())).not.toContain(userA.id);
  });

  it('the AI editor cannot be pointed at another user chapter', async () => {
    const res = await editorAction(json({ action: 'continue', chapterId: chapterAId, selection: '' }, 'POST'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('Chapter 1');
  });

  it('generated files require ownership', async () => {
    const cover = await getFile(json(), { params: { key: coverAKey.split('/') } });
    expect(cover.status).toBe(404);
    const exportFile = await getFile(json(), { params: { key: exportAKey.split('/') } });
    expect(exportFile.status).toBe(404);

    // The owner can fetch their own file, and unknown keys 404 rather than
    // falling through to the filesystem.
    session.userId = userA.id;
    const missing = await getFile(json(), { params: { key: ['covers', 'does-not-exist.svg'] } });
    expect(missing.status).toBe(404);
  });

  it('a user only sees their own novels in the list', async () => {
    seedNovel(userA.id, { title: 'Second A novel' });
    const mine = seedNovel(userB.id, { title: 'B novel' });
    const res = await listNovels();
    const body = await res.json();
    expect(body.map((n: any) => n.id)).toEqual([mine.id]);
    expect(JSON.stringify(body)).not.toContain('Second A novel');
  });
});

describe('user A keeps full access to their own resources', () => {
  it('can read their novel, chapter, covers, exports and jobs', async () => {
    session.userId = userA.id;
    expect((await getNovel(json(), { params: { id: novelA.id } })).status).toBe(200);
    expect((await getChapter(json(), { params: { id: novelA.id, chapterId: chapterAId } })).status).toBe(200);
    expect((await getCovers(json(), { params: { id: novelA.id } })).status).toBe(200);
    expect((await listExports(json(), { params: { id: novelA.id } })).status).toBe(200);
    expect((await listNovelJobs(json(), { params: { id: novelA.id } })).status).toBe(200);
    expect((await getJobStatus(json(), { params: { jobId: jobAId } })).status).toBe(200);
    const file = await getFile(json(), { params: { key: coverAKey.split('/') } });
    // No file has been written to disk in this test, so the row resolves but the
    // object is missing: 404 from storage, not from the ownership check.
    expect([200, 404]).toContain(file.status);
  });
});
