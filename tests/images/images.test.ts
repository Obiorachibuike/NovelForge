import { describe, expect, it, beforeEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { freshDatabase, seedUser, seedNovel, seedCover, db, jsonRequest, readJson, reopenDatabase } from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { GET as listCoversRoute, POST as generateCoversRoute, PUT as selectCoverRoute } from '@/app/api/novels/[id]/cover/route';
import { MAX_COVERS_PER_NOVEL, generateCovers, makeSvgCover } from '@/services/images/service';
import { readFile } from '@/lib/storage';
import { resetOpenAIForTests } from '@/lib/ai/provider';

let user: { id: string; email: string; name: string };
let novel: { id: string; userId: string };

beforeEach(() => {
  freshDatabase();
  user = seedUser();
  novel = seedNovel(user.id, { title: 'Ledger of Small Gods', genre: 'Fantasy', tone: 'melancholy' });
  session.userId = user.id;
  delete process.env.OPENAI_API_KEY;
  process.env.AI_DEMO_MODE = 'true';
  resetOpenAIForTests();
});

describe('cover concepts', () => {
  it('demo mode produces labelled SVG concepts that persist on disk', async () => {
    const covers = await generateCovers(user.id, novel.id, undefined, 2);
    expect(covers).toHaveLength(2);
    for (const cover of covers) {
      expect(cover.source).toBe('demo');
      expect(cover.provider).toBe('demo-svg');
      expect(cover.url).toBe(`/api/files/${(db().prepare('SELECT storageKey FROM image_assets WHERE id=?').get(cover.imageId) as any).storageKey}`);
      const stored = db().prepare('SELECT * FROM image_assets WHERE id=?').get(cover.imageId) as any;
      expect(stored.storageKey).toMatch(/^covers\/.+\.svg$/);
      expect(existsSync(path.join(process.env.DATA_DIR!, 'uploads', stored.storageKey))).toBe(true);
      const file = await readFile(stored.storageKey);
      expect(file?.data.toString('utf8')).toContain('<svg');
    }
  });

  it('demo output is never billed as a real image', async () => {
    await generateCovers(user.id, novel.id, undefined, 1);
    const billed = db().prepare(`SELECT COUNT(*) AS c FROM ai_usage WHERE taskType='image' AND source='openai'`).get() as any;
    expect(billed.c).toBe(0);
  });

  it('real mode that fails is labelled svg-fallback with the reason, never openai', async () => {
    process.env.OPENAI_API_KEY = 'sk-invalid-never-used';
    process.env.AI_DEMO_MODE = 'false';
    resetOpenAIForTests();

    const covers = await generateCovers(user.id, novel.id, undefined, 1);
    expect(covers[0].source).toBe('svg-fallback');
    expect(covers[0].provider).toBe('svg-fallback');
    expect(covers[0].fallbackReason).toBeTruthy();
    const row = db().prepare('SELECT provider FROM image_assets WHERE id=?').get(covers[0].imageId) as any;
    expect(row.provider).not.toBe('openai');
  });

  it('stops at the per-novel ceiling instead of spending without bound', async () => {
    for (let i = 0; i < MAX_COVERS_PER_NOVEL; i++) {
      seedCover(user.id, novel.id);
    }
    const res = await generateCoversRoute(jsonRequest(`/api/novels/${novel.id}/cover`, { prompt: 'one more', variants: 1 }, { method: 'POST' }), { params: { id: novel.id } });
    expect(res.status).toBe(429);
    expect((await readJson(res)).code).toBe('cover_limit_reached');
    expect(db().prepare('SELECT COUNT(*) AS c FROM image_assets WHERE novelId=?').get(novel.id)).toEqual({ c: MAX_COVERS_PER_NOVEL });
  });

  it('records a hard ceiling error rather than partial writes', async () => {
    for (let i = 0; i < MAX_COVERS_PER_NOVEL - 1; i++) seedCover(user.id, novel.id);
    const res = await generateCoversRoute(jsonRequest(`/api/novels/${novel.id}/cover`, { prompt: 'too many', variants: 2 }, { method: 'POST' }), { params: { id: novel.id } });
    // 23 existing + 2 requested = 25 > 24 → rejected before generating anything.
    expect(res.status).toBe(429);
    expect(db().prepare('SELECT COUNT(*) AS c FROM image_assets WHERE novelId=?').get(novel.id)).toEqual({ c: MAX_COVERS_PER_NOVEL - 1 });
  });

  it('validates the prompt and variant count before calling the provider', async () => {
    const long = await generateCoversRoute(jsonRequest(`/api/novels/${novel.id}/cover`, { prompt: 'x'.repeat(2000) }, { method: 'POST' }), { params: { id: novel.id } });
    expect(long.status).toBe(400);
    const many = await generateCoversRoute(jsonRequest(`/api/novels/${novel.id}/cover`, { prompt: 'ok', variants: 9 }, { method: 'POST' }), { params: { id: novel.id } });
    expect(many.status).toBe(400);
  });
});

describe('cover selection', () => {
  it('selects a concept, marks it primary and advances the stage', async () => {
    db().prepare(`UPDATE novels SET stage='cover' WHERE id=?`).run(novel.id);
    const [first, second] = await generateCovers(user.id, novel.id, undefined, 2);
    const res = await selectCoverRoute(jsonRequest(`/api/novels/${novel.id}/cover`, { imageId: second.imageId }, { method: 'PUT' }), { params: { id: novel.id } });
    expect(res.status).toBe(200);

    const rows = db().prepare('SELECT id, isPrimary FROM image_assets WHERE novelId=?').all(novel.id) as any[];
    expect(rows.find(r => r.id === second.imageId)!.isPrimary).toBe(1);
    expect(rows.find(r => r.id === first.imageId)!.isPrimary).toBe(0);

    const novelRow = db().prepare('SELECT coverImageId, stage FROM novels WHERE id=?').get(novel.id) as any;
    expect(novelRow.coverImageId).toBe(second.imageId);
    expect(novelRow.stage).toBe('prepare');
  });

  it('refuses to select a cover belonging to another novel', async () => {
    const other = seedNovel(user.id, { title: 'Another' });
    const foreign = seedCover(user.id, other.id);
    const res = await selectCoverRoute(jsonRequest(`/api/novels/${novel.id}/cover`, { imageId: foreign }, { method: 'PUT' }), { params: { id: novel.id } });
    expect(res.status).toBe(404);
    expect((db().prepare('SELECT coverImageId FROM novels WHERE id=?').get(novel.id) as any).coverImageId).toBeNull();
  });

  it('lists only the concepts of the requested novel', async () => {
    await generateCovers(user.id, novel.id, undefined, 1);
    const other = seedNovel(user.id, { title: 'Another' });
    seedCover(user.id, other.id);
    const list = await readJson(await listCoversRoute(jsonRequest(`/api/novels/${novel.id}/cover`), { params: { id: novel.id } }));
    expect(list).toHaveLength(1);
    expect(list[0].novelId).toBe(novel.id);
  });
});

describe('persistence', () => {
  it('covers survive a restart and are still downloadable by the owner', async () => {
    const [cover] = await generateCovers(user.id, novel.id, undefined, 1);
    const key = (db().prepare('SELECT storageKey FROM image_assets WHERE id=?').get(cover.imageId) as any).storageKey;

    reopenDatabase();
    const row = db().prepare('SELECT storageKey FROM image_assets WHERE id=?').get(cover.imageId) as any;
    expect(row.storageKey).toBe(key);
    expect((await readFile(row.storageKey))?.data.length).toBeGreaterThan(100);
  });
});

describe('svg cover generator', () => {
  it('escapes text so titles cannot inject markup', () => {
    const svg = makeSvgCover({ title: 'A <script>alert(1)</script> "Novel" & more', genre: 'Fantasy', tone: 'x' }).toString('utf8');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('&amp;');
    expect(svg.startsWith('<?xml')).toBe(true);
  });
});
