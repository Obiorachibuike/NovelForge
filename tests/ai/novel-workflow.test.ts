import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { freshDatabase, seedUser, seedNovel, seedOutline, seedChapter, db, jsonRequest, readJson } from '../helpers/db';
import { __setFetchForTests } from '@/lib/ai/huggingface-client';
import { __setRetrySleepForTests } from '@/lib/ai/retry-policy';
import { resetCircuitBreakersForTests } from '@/lib/ai/circuit-breaker';
import { resetVerificationCacheForTests } from '@/lib/ai/model-verification';
import { patchModel, syncRegistry } from '@/lib/ai/model-registry';
import { drainQueue, getJob } from '@/lib/queue';
import {
  BIG_PNG_BASE64, chatHandler, chatSuccess, imageHandler, imageSuccessBase64, jsonResponse, mockFetch,
  useHuggingFaceBackend, type MockRouter,
} from './helpers';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { POST as prepareRoute } from '@/app/api/novels/[id]/prepare/route';
import { GET as getStoryBibleRoute } from '@/app/api/novels/[id]/premise/route';
import { POST as outlineRoute } from '@/app/api/novels/[id]/outline/route';
import { POST as chapterRoute, GET as listChaptersRoute } from '@/app/api/novels/[id]/chapters/route';
import { PATCH as saveChapterRoute } from '@/app/api/novels/[id]/chapters/[chapterId]/route';
import { POST as coverRoute } from '@/app/api/novels/[id]/cover/route';
import { POST as editorActionRoute } from '@/app/api/ai/editor-action/route';

let user: { id: string; email: string; name: string };
let novel: { id: string; userId: string };
let restoreEnv: () => void;
let fetchMock: MockRouter;

const PREMISE_PAYLOAD = {
  logline: 'A cartographer who maps a city that keeps moving.',
  shortSynopsis: 'Sera maps the shifting city of Ashgrave and discovers she is part of the map.',
  fullSynopsis:
    'Sera Vance takes a commission to map Ashgrave, a city that rearranges itself at midnight. Each survey she completes is undone by morning, until she realises the map has been recording her as carefully as she has been recording it.',
  setting: 'Ashgrave, a city that rearranges itself at night.',
  themes: ['memory', 'belonging', 'control'],
  majorConflicts: ['Sera against the city', 'Sera against her own need for order'],
  mainCharacters: [
    { name: 'Sera Vance', role: 'protagonist', age: '34', personality: 'precise, guarded', motivation: 'to finish a map nobody else could', goal: 'map Ashgrave', fear: 'being forgotten', arc: 'learns to be unmapped' },
  ],
  supportingCharacters: [
    { name: 'Odile Ren', role: 'supporting', personality: 'warm, evasive', motivation: 'to keep the citys secret' },
  ],
  worldRules: [{ name: 'Midnight rearrangement', description: 'The city rearranges itself at midnight.', category: 'geography' }],
  timelineFoundation: [{ label: 'Arrival', description: 'Sera arrives in Ashgrave with a blank ledger.', when: 'Year 1', orderIndex: 0 }],
};

const OUTLINE_PAYLOAD = {
  acts: [{ actNumber: 1, name: 'Arrival', description: 'Sera reaches Ashgrave', purpose: 'Set the hook', turningPoint: 'The street moves', orderIndex: 0 }],
  chapters: [
    { chapterNumber: 1, title: 'Arrival', summary: 'Sera arrives in Ashgrave.', narrativePurpose: 'Set the hook', majorEvents: ['Sera crosses the bridge'], charactersInvolved: ['Sera Vance'], location: 'Ashgrave', conflict: 'Order vs chaos', emotionalObjective: 'wonder', plotAdvancement: 'Sera takes the commission', foreshadowing: 'A street she cannot find twice', targetWords: 2200, estimatedPages: 7 },
    { chapterNumber: 2, title: 'The Wrong Street', summary: 'A street refuses to be mapped.', narrativePurpose: 'Raise the stakes', majorEvents: ['The street moves'], charactersInvolved: ['Sera Vance'], location: 'Ashgrave', conflict: 'Map vs city', emotionalObjective: 'dread', plotAdvancement: 'The pattern emerges', foreshadowing: 'Her own name in the ledger', targetWords: 2200, estimatedPages: 7 },
    { chapterNumber: 3, title: 'Unmapped', summary: 'Sera chooses to let go of the map.', narrativePurpose: 'Resolve', majorEvents: ['Sera burns the map'], charactersInvolved: ['Sera Vance'], location: 'Ashgrave', conflict: 'Control vs trust', emotionalObjective: 'acceptance', plotAdvancement: 'The city stabilises', foreshadowing: 'A street she cannot find twice', targetWords: 2200, estimatedPages: 7 },
  ],
};

beforeEach(() => {
  freshDatabase();
  resetCircuitBreakersForTests();
  resetVerificationCacheForTests();
  restoreEnv = useHuggingFaceBackend();
  __setRetrySleepForTests(async () => {});
  user = seedUser({ name: 'Author' });
  novel = seedNovel(user.id, { title: 'The Moving City', targetChapters: 3 });
  session.userId = user.id;
  syncRegistry();
  // One clearly eligible model keeps the "automatic" choice deterministic.
  patchModel('Qwen/Qwen2.5-7B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
  patchModel('black-forest-labs/FLUX.1-schnell', { availabilityStatus: 'available', pricingStatus: 'free' });
});

afterEach(() => {
  __setFetchForTests(null);
  __setRetrySleepForTests(null);
  resetCircuitBreakersForTests();
  restoreEnv();
});

/**
 * Runs every queued job to completion, pulling retry backoffs forward so a
 * test does not have to wait out the queue's exponential schedule.
 */
async function drain() {
  for (let i = 0; i < 12; i++) {
    const queued = db().prepare(`SELECT COUNT(*) AS c FROM generation_jobs WHERE status='queued'`).get() as any;
    if (!queued.c) break;
    db().prepare(`UPDATE generation_jobs SET scheduledAt=? WHERE status='queued' AND (scheduledAt IS NULL OR scheduledAt > ?)`).run(new Date().toISOString(), new Date().toISOString());
    if (!(await drainQueue({ limit: 4, workerId: 'ai-workflow' })).length) break;
  }
}

describe('authoring workflow on hosted inference', () => {
  it('generates the story bible through a hosted model and persists it', async () => {
    fetchMock = mockFetch([chatHandler(() => chatSuccess(JSON.stringify(PREMISE_PAYLOAD), {}, 'together'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await prepareRoute(jsonRequest(`/api/novels/${novel.id}/prepare`, {}, { method: 'POST' }), { params: { id: novel.id } });
    expect(res.status).toBe(200);
    const { jobId } = await readJson(res);
    await drain();

    const job = await getJob(jobId);
    expect(job?.status).toBe('completed');
    expect(job?.actualModel).toBe('Qwen/Qwen2.5-7B-Instruct');

    const bible = await readJson(await getStoryBibleRoute(jsonRequest(`/api/novels/${novel.id}/premise`), { params: { id: novel.id } }));
    expect(bible.premise.logline).toContain('cartographer');
    const characters = db().prepare('SELECT name, role FROM characters WHERE novelId=?').all(novel.id) as any[];
    expect(characters.map(c => c.name)).toContain('Sera Vance');
    const rules = db().prepare('SELECT name FROM world_rules WHERE novelId=?').all(novel.id) as any[];
    expect(rules.map(r => r.name)).toContain('Midnight rearrangement');
  });

  it('generates an outline from the story bible', async () => {
    fetchMock = mockFetch([chatHandler(() => chatSuccess(JSON.stringify(OUTLINE_PAYLOAD), {}, 'together'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await outlineRoute(jsonRequest(`/api/novels/${novel.id}/outline`, {}, { method: 'POST' }), { params: { id: novel.id } });
    expect(res.status).toBe(200);
    await drain();

    const chapters = db().prepare('SELECT chapterNumber, title FROM chapter_outlines WHERE novelId=? ORDER BY chapterNumber').all(novel.id) as any[];
    expect(chapters).toHaveLength(3);
    expect(chapters[0].title).toBe('Arrival');
  });

  it('generates a chapter, records provenance, and keeps the sequential gate', async () => {
    seedOutline(novel.id, 3);
    patchModel('Qwen/Qwen2.5-14B-Instruct', { availabilityStatus: 'unverified', pricingStatus: 'unknown' });
    fetchMock = mockFetch([chatHandler(() => chatSuccess('Sera crossed the bridge at dusk, and the city shifted behind her.', {}, 'together'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    // Chapter 2 cannot be generated before chapter 1 exists.
    const blocked = await chapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 2 }, { method: 'POST' }), { params: { id: novel.id } });
    expect(blocked.status).toBe(409);

    const first = await chapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 1 }, { method: 'POST' }), { params: { id: novel.id } });
    expect(first.status).toBe(200);
    const { jobId } = await readJson(first);
    await drain();

    const job = await getJob(jobId);
    expect(job?.status).toBe('completed');
    expect(job?.actualModel).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(job?.requestedModel).toBe('auto');

    const chapter = db().prepare('SELECT * FROM chapters WHERE novelId=? AND chapterNumber=1').get(novel.id) as any;
    expect(chapter.plainText).toContain('Sera crossed the bridge');
    expect(chapter.wordCount).toBeGreaterThan(0);
    expect(chapter.status).toBe('generated');

    const usage = db().prepare('SELECT * FROM ai_usage WHERE taskType=? ORDER BY createdAt DESC LIMIT 1').get('chapter') as any;
    expect(usage.actualModel).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(usage.source).toBe('huggingface');
  });

  it('uses the requested model when the writer picks one and records it as requested', async () => {
    seedOutline(novel.id, 3);
    patchModel('Qwen/Qwen2.5-14B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    fetchMock = mockFetch([chatHandler(() => chatSuccess('A window that looked out on a different century.', {}, 'together'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await chapterRoute(
      jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 1, textModel: 'Qwen/Qwen2.5-14B-Instruct', allowFallback: true }, { method: 'POST' }),
      { params: { id: novel.id } },
    );
    expect(res.status).toBe(200);
    const { jobId } = await readJson(res);
    await drain();

    const job = await getJob(jobId);
    expect(job?.requestedModel).toBe('Qwen/Qwen2.5-14B-Instruct');
    expect(job?.actualModel).toBe('Qwen/Qwen2.5-14B-Instruct');
    expect(fetchMock.calls[0].body.model).toBe('Qwen/Qwen2.5-14B-Instruct');
  });

  it('falls back to another hosted text model and records the substitution', async () => {
    seedOutline(novel.id, 3);
    patchModel('Qwen/Qwen2.5-14B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    fetchMock = mockFetch([
      chatHandler(body =>
        body.model === 'Qwen/Qwen2.5-7B-Instruct'
          ? jsonResponse({ error: 'Model not found' }, 404)
          : chatSuccess('The lighthouse keeper wrote down every ship that never arrived.', {}, 'together'),
      ),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await chapterRoute(
      jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 1, textModel: 'Qwen/Qwen2.5-7B-Instruct', allowFallback: true }, { method: 'POST' }),
      { params: { id: novel.id } },
    );
    const { jobId } = await readJson(res);
    await drain();

    const job = await getJob(jobId);
    expect(job?.status).toBe('completed');
    expect(job?.requestedModel).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(job?.actualModel).toBe('Qwen/Qwen2.5-14B-Instruct');
    expect(job?.fallbackCount).toBe(1);
    const chapter = db().prepare('SELECT plainText FROM chapters WHERE novelId=?').get(novel.id) as any;
    expect(chapter.plainText).toContain('lighthouse keeper');
  });

  it('fails a job honestly when every model fails (no fabricated chapter)', async () => {
    seedOutline(novel.id, 3);
    fetchMock = mockFetch([chatHandler(() => jsonResponse({ error: 'Service overloaded' }, 503))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await chapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 1 }, { method: 'POST' }), { params: { id: novel.id } });
    const { jobId } = await readJson(res);
    await drain();

    const job = await getJob(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/Text generation failed/i);
    expect(job?.error).toMatch(/Check model availability/i);
    const chapters = db().prepare('SELECT COUNT(*) AS c FROM chapters WHERE novelId=?').get(novel.id) as any;
    expect(chapters.c).toBe(0);
  });

  it('preserves writer edits and regenerates from the edited text', async () => {
    seedOutline(novel.id, 3);
    const chapterId = seedChapter(novel.id, { chapterNumber: 1, status: 'generated', plainText: 'The original opening line.' });
    fetchMock = mockFetch([chatHandler(() => chatSuccess('A freshly rewritten opening that keeps the authors change.', {}, 'together'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const edited = 'The original opening line. Plus a sentence the author added by hand.';
    const contentJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: edited }] }] };
    const saved = await saveChapterRoute(
      jsonRequest(`/api/novels/${novel.id}/chapters/${chapterId}`, { contentJson, title: 'Arrival' }, { method: 'PATCH' }),
      { params: { id: novel.id, chapterId } },
    );
    expect(saved.status).toBe(200);

    const afterEdit = db().prepare('SELECT plainText, currentVersionId FROM chapters WHERE id=?').get(chapterId) as any;
    expect(afterEdit.plainText).toContain('added by hand');
    expect(afterEdit.currentVersionId).toBeTruthy();

    // Regeneration requires an explicit overwrite confirmation when the draft
    // carries the author's own edits, and it creates a new revision.
    const regenerated = await chapterRoute(
      jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 1, confirmOverwrite: true }, { method: 'POST' }),
      { params: { id: novel.id } },
    );
    expect(regenerated.status).toBe(200);
    await drain();

    const versions = db().prepare('SELECT COUNT(*) AS c FROM chapter_versions WHERE chapterId=?').get(chapterId) as any;
    expect(versions.c).toBeGreaterThanOrEqual(1);
    const final = db().prepare('SELECT plainText FROM chapters WHERE id=?').get(chapterId) as any;
    expect(final.plainText).toContain('freshly rewritten');
  });

  it('generates a cover through hosted inference and stores it through the storage layer', async () => {
    fetchMock = mockFetch([imageHandler(() => imageSuccessBase64(BIG_PNG_BASE64, 'fal-ai'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await coverRoute(
      jsonRequest(`/api/novels/${novel.id}/cover`, { variants: 1, imageModel: 'black-forest-labs/FLUX.1-schnell', allowFallback: true }, { method: 'POST' }),
      { params: { id: novel.id } },
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].source).toBe('huggingface');
    expect(body[0].actualModel).toBe('black-forest-labs/FLUX.1-schnell');

    const asset = db().prepare('SELECT * FROM image_assets WHERE novelId=? ORDER BY createdAt DESC LIMIT 1').get(novel.id) as any;
    expect(asset.model).toBe('black-forest-labs/FLUX.1-schnell');
    expect(asset.provider).not.toBe('svg-fallback');
    expect(asset.bytes).toBeGreaterThan(1_000);
  });

  it('serves the AI editor action through hosted inference', async () => {
    fetchMock = mockFetch([chatHandler(() => chatSuccess('The rewritten sentence reads cleanly.', {}, 'together'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const chapterId = seedChapter(novel.id, { chapterNumber: 1, status: 'generated', plainText: 'The city moved again, and Sera felt the map slip.' });
    const res = await editorActionRoute(jsonRequest('/api/ai/editor-action', {
      action: 'rewrite',
      chapterId,
      selection: 'The city moved again, and Sera felt the map slip.',
    }, { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(String(body.text ?? body.result ?? '')).toContain('rewritten sentence');
  });

  it('keeps progress through a failed generation so the writer can retry', async () => {
    seedOutline(novel.id, 3);
    fetchMock = mockFetch([chatHandler(() => jsonResponse({ error: 'Model is currently loading' }, 503))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const first = await chapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 1 }, { method: 'POST' }), { params: { id: novel.id } });
    const { jobId } = await readJson(first);
    await drain();
    expect((await getJob(jobId))?.status).toBe('failed');

    // The story bible, outline and novel remain intact; only the chapter is missing.
    expect((db().prepare('SELECT COUNT(*) AS c FROM novels WHERE id=?').get(novel.id) as any).c).toBe(1);
    expect((db().prepare('SELECT COUNT(*) AS c FROM chapter_outlines WHERE novelId=?').get(novel.id) as any).c).toBe(3);
    const relist = await readJson(await listChaptersRoute(jsonRequest(`/api/novels/${novel.id}/chapters`), { params: { id: novel.id } }));
    expect(relist.length).toBe(0);

    // A retry with a working model succeeds.
    __setFetchForTests(mockFetch([chatHandler(() => chatSuccess('The second attempt produced real prose.', {}, 'together'))]) as unknown as typeof fetch);
    const retry = await chapterRoute(jsonRequest(`/api/novels/${novel.id}/chapters`, { chapterNumber: 1 }, { method: 'POST' }), { params: { id: novel.id } });
    expect(retry.status).toBe(200);
    await drain();
    const chapter = db().prepare('SELECT plainText FROM chapters WHERE novelId=?').get(novel.id) as any;
    expect(chapter.plainText).toContain('second attempt');
  });
});
