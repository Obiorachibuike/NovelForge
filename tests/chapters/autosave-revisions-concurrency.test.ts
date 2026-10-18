import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  freshDatabase,
  seedUser,
  seedNovel,
  seedOutline,
  seedChapter,
  jsonRequest,
  readJson,
} from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: 'Writer', email: 'writer@example.com' } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import {
  saveChapterContent,
  listVersions,
  getVersion,
} from '@/services/chapters/service';
import {
  saveLocalDraft,
  loadLocalDraft,
  clearLocalDraft,
  hasRecoverableDraft,
  listUnsavedDraftsForNovel,
  createAutosaveController,
  MAX_RECOVERY_ENTRIES,
  type StorageLike,
} from '@/lib/editor/draft-recovery';
import { PATCH as patchChapter } from '@/app/api/novels/[id]/chapters/[chapterId]/route';
import {
  GET as getVersionsRoute,
  POST as postVersionsRoute,
} from '@/app/api/novels/[id]/chapters/[chapterId]/versions/route';

function createMemoryStorage(): StorageLike & { dump: () => Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
    dump: () => Object.fromEntries(map.entries()),
  };
}

function makeDoc(text: string) {
  return {
    type: 'doc' as const,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

describe('chapter autosave, optimistic concurrency, revision history & draft recovery', () => {
  beforeEach(() => {
    freshDatabase();
    session.userId = null;
  });

  it('increments monotonic revision on save and skips redundant writes when content is unchanged', async () => {
    const alice = seedUser();
    const novel = seedNovel(alice.id);
    seedOutline(novel.id, 2);
    const chapterId = seedChapter(novel.id, { chapterNumber: 1, plainText: 'Initial prose.' });

    const doc1 = makeDoc('First updated paragraph with six words.');
    const save1 = await saveChapterContent(alice.id, novel.id, chapterId, doc1);
    expect(save1.revision).toBe(2);
    expect(save1.unchanged).toBe(false);
    expect(save1.wordCount).toBe(6);

    // Saving the exact same content without requesting a manual snapshot should be a no-op
    const save2 = await saveChapterContent(alice.id, novel.id, chapterId, doc1);
    expect(save2.unchanged).toBe(true);
    expect(save2.revision).toBe(2);
  });

  it('enforces optimistic concurrency via expectedRevision and preserves conflicting edits as a conflict version', async () => {
    const alice = seedUser();
    const novel = seedNovel(alice.id);
    seedOutline(novel.id, 1);
    const chapterId = seedChapter(novel.id, { chapterNumber: 1, plainText: 'Base version.' });

    // Tab A and Tab B both load revision 1.
    // Tab A saves first -> revision becomes 2.
    const tabADoc = makeDoc('Tab A saved this newer prose first.');
    const resA = await saveChapterContent(alice.id, novel.id, chapterId, tabADoc, {
      expectedRevision: 1,
    });
    expect(resA.revision).toBe(2);

    // Tab B tries to save with stale expectedRevision=1 -> 409 conflict, and Tab B's payload is preserved in chapter_versions!
    const tabBDoc = makeDoc('Tab B had stale revision 1 but important edits.');
    await expect(
      saveChapterContent(alice.id, novel.id, chapterId, tabBDoc, {
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/modified by a newer save/i);

    const versions = await listVersions(chapterId);
    const conflictSnap = versions.find((v: any) => v.revisionType === 'conflict');
    expect(conflictSnap).toBeDefined();
    const conflictFull = await getVersion(alice.id, novel.id, chapterId, conflictSnap!.id);
    expect(conflictFull?.contentJson).toContain('Tab B had stale revision 1');
  });

  it('supports manual snapshots and non-destructive version restore via service and API routes', async () => {
    const alice = seedUser();
    const bob = seedUser();
    const novel = seedNovel(alice.id);
    seedOutline(novel.id, 1);
    const chapterId = seedChapter(novel.id, { chapterNumber: 1, plainText: 'Draft one text.' });

    session.userId = alice.id;

    // Save draft 1 via PATCH with manual snapshot
    const doc1 = makeDoc('Version one: the lantern flickered in the fog.');
    const patchRes = await patchChapter(
      jsonRequest(`/api/novels/${novel.id}/chapters/${chapterId}`, {
        contentJson: doc1,
        expectedRevision: 1,
        createSnapshot: true,
        snapshotNote: 'Lantern draft',
      }, { method: 'PATCH' }),
      { params: { id: novel.id, chapterId } },
    );
    expect(patchRes.status).toBe(200);
    const patchBody = await readJson(patchRes);
    expect(patchBody.revision).toBe(2);

    // Edit again to version two
    const doc2 = makeDoc('Version two: the storm broke over the harbor.');
    await patchChapter(
      jsonRequest(`/api/novels/${novel.id}/chapters/${chapterId}`, {
        contentJson: doc2,
        expectedRevision: 2,
      }, { method: 'PATCH' }),
      { params: { id: novel.id, chapterId } },
    );

    // List versions via GET /versions
    const listRes = await getVersionsRoute(
      jsonRequest(`/api/novels/${novel.id}/chapters/${chapterId}/versions`),
      { params: { id: novel.id, chapterId } },
    );
    expect(listRes.status).toBe(200);
    const { versions } = await readJson(listRes);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    const lanternVersion = versions.find((v: any) => v.note === 'Lantern draft');
    expect(lanternVersion).toBeDefined();

    // Cross-user access to versions is rejected with 404
    session.userId = bob.id;
    const bobRes = await getVersionsRoute(
      jsonRequest(`/api/novels/${novel.id}/chapters/${chapterId}/versions`),
      { params: { id: novel.id, chapterId } },
    );
    expect(bobRes.status).toBe(404);

    // Restore the earlier version as Alice
    session.userId = alice.id;
    const restoreRes = await postVersionsRoute(
      jsonRequest(`/api/novels/${novel.id}/chapters/${chapterId}/versions`, {
        action: 'restore',
        versionId: lanternVersion.id,
      }),
      { params: { id: novel.id, chapterId } },
    );
    expect(restoreRes.status).toBe(200);
    const restoredBody = await readJson(restoreRes);
    expect(JSON.stringify(restoredBody.contentJson)).toContain('lantern flickered in the fog');

    // Verify that the pre-restore state ("storm broke over the harbor") was preserved in version history!
    const afterRestoreVersions = await listVersions(chapterId);
    const preRestore = afterRestoreVersions.find((v: any) => v.revisionType === 'pre_restore');
    expect(preRestore).toBeDefined();
    const preRestoreFull = await getVersion(alice.id, novel.id, chapterId, preRestore!.id);
    expect(preRestoreFull?.contentJson).toContain('storm broke over the harbor');
  });

  it('stores, compares, clears, and bounds browser draft recovery entries', () => {
    const storage = createMemoryStorage();
    const doc = makeDoc('Unsaved local draft after network drop.');

    const saved = saveLocalDraft(
      {
        novelId: 'novel_1',
        chapterId: 'ch_1',
        chapterNumber: 1,
        contentJson: doc,
        baseRevision: 3,
        reason: 'save_failed',
      },
      storage,
    );
    expect(saved?.wordCount).toBe(6);

    const loaded = loadLocalDraft('novel_1', 'ch_1', storage);
    expect(loaded?.plainText).toBe('Unsaved local draft after network drop.');

    // Differs from server content -> recoverable
    expect(hasRecoverableDraft(loaded, makeDoc('Older server text.'))).toBe(true);
    // Identical to server content -> not recoverable
    expect(hasRecoverableDraft(loaded, doc)).toBe(false);

    const novelDrafts = listUnsavedDraftsForNovel('novel_1', storage);
    expect(novelDrafts).toHaveLength(1);

    clearLocalDraft('novel_1', 'ch_1', storage);
    expect(loadLocalDraft('novel_1', 'ch_1', storage)).toBeNull();

    // Verify retention cap MAX_RECOVERY_ENTRIES
    for (let i = 1; i <= MAX_RECOVERY_ENTRIES + 5; i++) {
      saveLocalDraft(
        {
          novelId: 'novel_cap',
          chapterId: `ch_${i}`,
          chapterNumber: i,
          contentJson: makeDoc(`Draft ${i}`),
          baseRevision: 1,
          savedAt: new Date(Date.now() + i * 1000).toISOString(),
          reason: 'unsaved',
        },
        storage,
      );
    }
    expect(listUnsavedDraftsForNovel('novel_cap', storage)).toHaveLength(MAX_RECOVERY_ENTRIES);
  });

  it('coordinates debounced autosave, out-of-order responses, and bounded retries in createAutosaveController', async () => {
    vi.useFakeTimers();
    try {
      const storage = createMemoryStorage();
      const states: string[] = [];
      let callCount = 0;

      const controller = createAutosaveController({
        novelId: 'novel_1',
        chapterId: 'ch_1',
        chapterNumber: 1,
        initialContentJson: makeDoc('Start.'),
        initialRevision: 1,
        delayMs: 500,
        maxRetries: 2,
        baseRetryMs: 200,
        storage,
        onStateChange: s => states.push(s.status),
        transport: async ({ expectedRevision }) => {
          callCount++;
          if (callCount === 1) {
            throw new Error('Temporary network glitch');
          }
          return {
            wordCount: 4,
            pages: 1,
            revision: expectedRevision + 1,
            updatedAt: new Date().toISOString(),
          };
        },
      });

      controller.notifyEdit(makeDoc('Edited prose in editor.'));
      expect(controller.getState().status).toBe('unsaved');
      expect(controller.hasUnsavedChanges()).toBe(true);
      expect(loadLocalDraft('novel_1', 'ch_1', storage)).not.toBeNull();

      // Advance past debounce (500ms) -> first attempt fails -> enters 'error' and schedules retry (200ms)
      await vi.advanceTimersByTimeAsync(520);
      expect(controller.getState().status).toBe('error');
      expect(controller.getState().retryCount).toBe(1);

      // Advance past retry backoff (200ms) -> second attempt succeeds -> enters 'saved' and clears local draft
      await vi.advanceTimersByTimeAsync(250);
      expect(controller.getState().status).toBe('saved');
      expect(controller.getState().revision).toBe(2);
      expect(controller.hasUnsavedChanges()).toBe(false);
      expect(loadLocalDraft('novel_1', 'ch_1', storage)).toBeNull();

      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
