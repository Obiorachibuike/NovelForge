import { describe, expect, it, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { freshDatabase, seedUser, seedNovel, seedOutline, seedChapter, seedCover, seedExportRow, db, jsonRequest, readJson, reopenDatabase } from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { GET as getSettingsRoute, PUT as putSettingsRoute } from '@/app/api/novels/[id]/settings/route';
import { GET as getNovelRoute } from '@/app/api/novels/[id]/route';
import { GET as getChapterRoute } from '@/app/api/novels/[id]/chapters/[chapterId]/route';
import { GET as getNovelJobsRoute } from '@/app/api/novels/[id]/jobs/route';
import { GET as listExportsRoute } from '@/app/api/novels/[id]/export/route';
import { enqueue, getJob } from '@/lib/queue';
import { resolveSqlitePath } from '@/lib/db';
import { migrations as MIGRATIONS } from '@/lib/db/migrations';
import { readFile, deleteFile } from '@/lib/storage';
import { registerHandler } from '@/lib/queue';

let user: { id: string; email: string; name: string };
let novel: { id: string; userId: string };
let chapterId: string;

beforeEach(() => {
  freshDatabase();
  user = seedUser();
  novel = seedNovel(user.id, { title: 'Persisted Kingdom' });
  seedOutline(novel.id, 3);
  chapterId = seedChapter(novel.id, { chapterNumber: 1, status: 'edited', plainText: 'Author prose that must survive a restart.' });
  session.userId = user.id;
});

describe('database durability', () => {
  it('applies versioned migrations once and records them', () => {
    const expected = MIGRATIONS.map(m => m.id.split('_')[0]);
    const applied = db().prepare('SELECT id, appliedAt FROM schema_migrations ORDER BY id').all() as any[];
    expect(applied.map(r => r.id.split('_')[0])).toEqual(expected);
    expect(applied.every(r => typeof r.appliedAt === 'string')).toBe(true);

    // Re-opening runs the migration step again; it must be a no-op.
    reopenDatabase();
    const again = db().prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as any;
    expect(again.c).toBe(expected.length);
    expect(db().prepare('SELECT plainText FROM chapters WHERE id=?').get(chapterId)).toMatchObject({
      plainText: 'Author prose that must survive a restart.',
    });
  });

  it('keeps chapters, settings, covers, jobs and exports after a restart', async () => {
    seedCover(user.id, novel.id, { storageKey: 'covers/persisted.svg' });
    seedExportRow(user.id, novel.id, { fileKey: 'exports/persisted.txt' });
    db().prepare(`UPDATE novel_settings SET fontSize=14, pageSize='a4', includeToc=0 WHERE novelId=?`).run(novel.id);
    const jobId = await enqueue({ type: 'noop', userId: user.id, novelId: novel.id, payload: { marker: 'kept' } });

    reopenDatabase();

    const novelRow = db().prepare('SELECT title FROM novels WHERE id=?').get(novel.id) as any;
    expect(novelRow.title).toBe('Persisted Kingdom');
    expect(db().prepare('SELECT plainText, status FROM chapters WHERE id=?').get(chapterId)).toMatchObject({
      plainText: 'Author prose that must survive a restart.',
      status: 'edited',
    });
    expect(db().prepare('SELECT fontSize, pageSize, includeToc FROM novel_settings WHERE novelId=?').get(novel.id)).toMatchObject({
      fontSize: 14, pageSize: 'a4', includeToc: 0,
    });
    expect(db().prepare('SELECT COUNT(*) AS c FROM image_assets WHERE novelId=?').get(novel.id)).toEqual({ c: 1 });
    expect(db().prepare('SELECT COUNT(*) AS c FROM exports WHERE novelId=?').get(novel.id)).toEqual({ c: 1 });
    const job = await getJob(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.payload).toContain('kept');
  });

  it('the database file really is on disk (not an in-memory database)', () => {
    expect(existsSync(resolveSqlitePath())).toBe(true);
    expect(path.isAbsolute(resolveSqlitePath())).toBe(true);
  });
});

describe('settings API', () => {
  it('persists formatting settings and returns them after a restart', async () => {
    const put = await putSettingsRoute(
      jsonRequest(`/api/novels/${novel.id}/settings`, { fontSize: 16, pageSize: 'trade', pageNumbering: 'top-right', includeToc: false }, { method: 'PUT' }),
      { params: { id: novel.id } },
    );
    expect(put.status).toBe(200);
    expect((await readJson(put)).fontSize).toBe(16);

    reopenDatabase();
    const get = await getSettingsRoute(jsonRequest(`/api/novels/${novel.id}/settings`), { params: { id: novel.id } });
    const settings = await readJson(get);
    expect(settings).toMatchObject({ fontSize: 16, pageSize: 'trade', pageNumbering: 'top-right', includeToc: 0 });
  });

  it('rejects unknown or out-of-range values without touching the row', async () => {
    const before = db().prepare('SELECT * FROM novel_settings WHERE novelId=?').get(novel.id) as any;
    const bad = await putSettingsRoute(jsonRequest(`/api/novels/${novel.id}/settings`, { fontSize: 200, isAdmin: true }, { method: 'PUT' }), { params: { id: novel.id } });
    expect(bad.status).toBe(400);
    const after = db().prepare('SELECT * FROM novel_settings WHERE novelId=?').get(novel.id) as any;
    expect(after).toEqual(before);
  });

  it('a user cannot read or change another user settings', async () => {
    const other = seedUser({ name: 'Other' });
    session.userId = other.id;
    expect((await getSettingsRoute(jsonRequest(`/api/novels/${novel.id}/settings`), { params: { id: novel.id } })).status).toBe(404);
    expect((await putSettingsRoute(jsonRequest(`/api/novels/${novel.id}/settings`, { fontSize: 20 }, { method: 'PUT' }), { params: { id: novel.id } })).status).toBe(404);
    expect((db().prepare('SELECT fontSize FROM novel_settings WHERE novelId=?').get(novel.id) as any).fontSize).toBe(12);
  });
});

describe('generated artefacts', () => {
  it('files written to storage are readable again after a restart', async () => {
    const { saveFile } = await import('@/lib/storage');
    const stored = await saveFile({ data: Buffer.from('persisted export bytes'), folder: 'exports', ext: 'txt' });
    expect(existsSync(path.join(process.env.DATA_DIR!, 'uploads', stored.key))).toBe(true);

    reopenDatabase();
    const read = await readFile(stored.key);
    expect(read?.data.toString()).toBe('persisted export bytes');

    await deleteFile(stored.key);
    expect(await readFile(stored.key)).toBeNull();
  });
});

describe('job durability', () => {
  it('queued work survives a restart and still runs afterwards', async () => {
    registerHandler('persist-check', async () => ({ ok: true }));
    const jobId = await enqueue({ type: 'persist-check', userId: user.id, novelId: novel.id, payload: {} });

    reopenDatabase();
    expect((await getJob(jobId))?.status).toBe('queued');

    const { drainQueue } = await import('@/lib/queue');
    const results = await drainQueue({ limit: 5, workerId: 'post-restart' });
    expect(results.find(r => r.id === jobId)?.status).toBe('completed');
  });

  it('the read APIs still serve the persisted rows after a restart', async () => {
    reopenDatabase();
    expect((await getNovelRoute(jsonRequest(`/api/novels/${novel.id}`), { params: { id: novel.id } })).status).toBe(200);
    expect((await getChapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters/${chapterId}`), { params: { id: novel.id, chapterId } })).status).toBe(200);
    expect((await getNovelJobsRoute(jsonRequest(`/api/novels/${novel.id}/jobs`), { params: { id: novel.id } })).status).toBe(200);
    expect((await listExportsRoute(jsonRequest(`/api/novels/${novel.id}/export`), { params: { id: novel.id } })).status).toBe(200);
  });
});
