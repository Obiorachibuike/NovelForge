import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  freshDatabase,
  db,
  seedUser,
  seedNovel,
  jsonRequest,
  readJson,
} from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: 'Writer', email: 'writer@example.com' } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { updatePremiseField, runPremise } from '@/services/preparation/service';
import { runOutline, approveOutline, updateOutline } from '@/services/outlines/service';
import {
  runChapterGeneration,
  saveChapterContent,
  approveChapter,
  restoreVersion,
  createVersion,
  listChapters,
} from '@/services/chapters/service';
import { getSettings } from '@/services/novels/service';
import { buildExport } from '@/services/exports/service';
import { createNovelBackup, restoreNovelBackup } from '@/services/backups/service';
import { validateEnvConfig } from '@/lib/config/env';
import { logger } from '@/lib/logger';
import { GET as listNovelsRoute } from '@/app/api/novels/route';
import { PATCH as patchNovelRoute, GET as getNovelRoute } from '@/app/api/novels/[id]/route';
import { GET as healthRoute } from '@/app/api/health/route';

describe('end-to-end authoring workflow, production health & config validation', () => {
  beforeEach(() => {
    freshDatabase();
    session.userId = null;
  });

  it('completes the full sequential authoring lifecycle from novel creation through export & backup', async () => {
    const alice = seedUser({ email: 'author@novelforge.example' });
    session.userId = alice.id;

    // 1. Create novel and update metadata via PATCH /api/novels/[id]
    const novel = seedNovel(alice.id, {
      title: 'The Starlight Cartographer',
      genre: 'Science Fiction',
      targetChapters: 3,
      stage: 'create',
    });

    const patchRes = await patchNovelRoute(
      jsonRequest(`/api/novels/${novel.id}`, {
        title: 'The Starlight Cartographer: Revised',
        tone: 'Lyrical and suspenseful',
        targetChapters: 3,
      }, { method: 'PATCH' }),
      { params: { id: novel.id } },
    );
    expect(patchRes.status).toBe(200);
    const updatedNovel = await readJson(patchRes);
    expect(updatedNovel.title).toBe('The Starlight Cartographer: Revised');
    expect(updatedNovel.tone).toBe('Lyrical and suspenseful');

    // 2. Generate Premise & Story Bible, then edit Premise fields (verifying the SQL bind count fix!)
    await runPremise({ userId: alice.id, novelId: novel.id });
    await updatePremiseField(novel.id, alice.id, {
      logline: 'A cartographer maps vanishing constellations across a fractured sector.',
      setting: 'The Meridian Drift',
      themes: ['Memory', 'Navigation'],
    });
    const premiseRow = db().prepare('SELECT * FROM premises WHERE novelId = ?').get(novel.id) as any;
    expect(premiseRow.logline).toContain('vanishing constellations');
    expect(premiseRow.setting).toBe('The Meridian Drift');

    // 3. Generate Outline, edit Chapter 1 plan, and approve Outline
    await runOutline({ userId: alice.id, novelId: novel.id, payload: { structureType: 'three-act' } });
    const ch1Outline = db()
      .prepare('SELECT * FROM chapter_outlines WHERE novelId = ? AND chapterNumber = 1')
      .get(novel.id) as any;
    expect(ch1Outline).toBeDefined();

    await updateOutline(ch1Outline.id, novel.id, alice.id, {
      title: 'The First Meridian',
      summary: 'Soren discovers a missing star chart in the observatory vault.',
    });
    await approveOutline(alice.id, novel.id);

    // 4. Sequential gating: Chapter 2 cannot be generated before Chapter 1 is approved
    await expect(
      runChapterGeneration({ userId: alice.id, novelId: novel.id, payload: { chapterNumber: 2 } }),
    ).rejects.toThrow(/Previous chapter must be approved/i);

    // 5. Generate Chapter 1, edit & autosave, create a snapshot, restore, and approve Chapter 1
    const gen1 = await runChapterGeneration({
      userId: alice.id,
      novelId: novel.id,
      payload: { chapterNumber: 1 },
    });
    expect(gen1.chapterId).toBeDefined();

    await saveChapterContent(
      alice.id,
      novel.id,
      gen1.chapterId!,
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Observatory vault snapshot paragraph.' }] }],
      },
    );
    const snap1 = await createVersion(alice.id, novel.id, gen1.chapterId!, 'Before rewrite');

    await saveChapterContent(
      alice.id,
      novel.id,
      gen1.chapterId!,
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Temporary rewrite paragraph.' }] }],
      },
    );

    const restored = await restoreVersion(alice.id, novel.id, gen1.chapterId!, snap1.id);
    expect(JSON.stringify(restored.contentJson)).toContain('Observatory vault snapshot paragraph.');

    const approved = await approveChapter(alice.id, novel.id, gen1.chapterId!);
    expect(approved.status).toBe('approved');

    // 6. Now Chapter 2 is unlocked and can be generated!
    const gen2 = await runChapterGeneration({
      userId: alice.id,
      novelId: novel.id,
      payload: { chapterNumber: 2 },
    });
    expect(gen2.chapterId).toBeDefined();

    // 7. Export manuscript and verify chapter order & titles
    const chapters = await listChapters(novel.id);
    const settings = getSettings(novel.id) as any;
    const novelRow = db().prepare('SELECT * FROM novels WHERE id = ?').get(novel.id) as any;
    const mdExport = await buildExport({
      novel: novelRow,
      chapters,
      settings,
      cover: null,
      format: 'markdown',
      author: alice.name,
    });
    const mdText = mdExport.buffer.toString('utf8');
    expect(mdText).toContain('The Starlight Cartographer: Revised');
    expect(mdText).toContain('Observatory vault snapshot paragraph.');

    // 8. Backup & restore verification
    const backup = await createNovelBackup(alice.id, novel.id);
    const clone = await restoreNovelBackup(alice.id, backup);
    expect(clone.chaptersRestored).toBe(2);
  });

  it('supports pagination on GET /api/novels and rejects suspended accounts with 403', async () => {
    const alice = seedUser();
    seedNovel(alice.id, { title: 'Novel A' });
    seedNovel(alice.id, { title: 'Novel B' });
    seedNovel(alice.id, { title: 'Novel C' });

    session.userId = alice.id;
    const pageRes = await listNovelsRoute(jsonRequest('/api/novels?limit=2&offset=0'));
    expect(pageRes.status).toBe(200);
    const pageBody = await readJson(pageRes);
    expect(pageBody).toHaveLength(2);

    // Suspend Alice's account and verify requireUser blocks access with 403 account_suspended
    db().prepare('UPDATE users SET status = ? WHERE id = ?').run('suspended', alice.id);
    const suspendedRes = await getNovelRoute(
      jsonRequest('/api/novels/any'),
      { params: { id: 'any' } },
    );
    expect(suspendedRes.status).toBe(403);
    const suspendedBody = await readJson(suspendedRes);
    expect(suspendedBody.code).toBe('account_suspended');
  });

  it('verifies /api/health, startup config validation, and structured secret-redacting logger', async () => {
    const res = await healthRoute();
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe('ok');
    expect(body.database.connected).toBe(true);
    expect(body.database.foreignKeysEnabled).toBe(true);
    // Updated by the hosted-inference migrations (0008 model registry, 0009 provenance).
    expect(body.database.latestMigrationVersion).toBe('0010_auth_recovery_tokens');
    expect(body.queue.status).toBe('healthy');

    // Startup config validator rejects weak/default AUTH_SECRET in production
    expect(() =>
      validateEnvConfig({
        NODE_ENV: 'production',
        AUTH_SECRET: 'replace-with-a-long-random-secret',
      } as any),
    ).toThrow(/AUTH_SECRET/i);

    // Structured logger redacts API keys, tokens, and chapter content fields
    const entry = logger.info('ai_job', 'Failed call with sk-proj-9876543210secretkey', {
      apiKey: 'sk-proj-9876543210secretkey',
      contentJson: '{"type":"doc","content":"private manuscript"}',
      novelId: 'novel_123',
    });
    expect(entry.event).toContain('sk-[REDACTED]');
    expect(entry.meta?.apiKey).toBe('[REDACTED]');
    expect(entry.meta?.contentJson).toBe('[REDACTED]');
    expect(entry.meta?.novelId).toBe('novel_123');
  });
});
