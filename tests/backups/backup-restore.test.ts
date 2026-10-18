import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  freshDatabase,
  db,
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
  createNovelBackup,
  restoreNovelBackup,
  validateBackupBundle,
  backupSqliteDatabaseFile,
} from '@/services/backups/service';
import { createVersion } from '@/services/chapters/service';
import { updatePremiseField } from '@/services/preparation/service';
import { GET as getBackupRoute, POST as postNovelBackupRoute } from '@/app/api/novels/[id]/backup/route';
import { POST as postRestoreRoute } from '@/app/api/novels/restore/route';

describe('novel backups, integrity validation & transactional restore', () => {
  beforeEach(() => {
    freshDatabase();
    session.userId = null;
  });

  it('exports a complete SHA-256 verified backup bundle and excludes sensitive credentials', async () => {
    const alice = seedUser({ email: 'alice@example.com' });
    db().prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run('bcrypt_secret_hash', alice.id);

    const novel = seedNovel(alice.id, { title: 'The Clockwork Archipelago', premise: 'Islands on brass gears.' });
    await updatePremiseField(novel.id, alice.id, {
      logline: 'An apprentice horologist discovers the ocean is winding down.',
      setting: 'The Brass Isles',
    });
    const now = new Date().toISOString();
    db().prepare(
      `INSERT INTO characters (id,novelId,name,role,motivation,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`,
    ).run('char_1', novel.id, 'Lyra Vance', 'protagonist', 'Wind the mainspring', now, now);

    seedOutline(novel.id, 2);
    const ch1 = seedChapter(novel.id, { chapterNumber: 1, title: 'The Mainspring', plainText: 'Gears turned beneath the tide.' });
    await createVersion(alice.id, novel.id, ch1, 'Initial snapshot');

    const bundle = await createNovelBackup(alice.id, novel.id);
    expect(bundle.manifest.format).toBe('novelforge-backup');
    expect(bundle.manifest.formatVersion).toBe(1);
    expect(bundle.manifest.counts.chapters).toBe(1);
    expect(bundle.manifest.counts.outlines).toBe(2);
    expect(bundle.manifest.counts.characters).toBe(1);
    expect(bundle.manifest.counts.chapterVersions).toBe(1);

    // Ensure no userId or passwordHash appears anywhere in the serialized backup
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('bcrypt_secret_hash');
    expect(serialized).not.toContain(alice.id);

    // Validate bundle passes checksum check
    const validated = validateBackupBundle(bundle);
    expect(validated.data.novel.title).toBe('The Clockwork Archipelago');
  });

  it('rejects tampered, corrupted, or version-incompatible backups without modifying live data', async () => {
    const alice = seedUser();
    const novel = seedNovel(alice.id, { title: 'Original Untouched Novel' });
    seedOutline(novel.id, 1);
    seedChapter(novel.id, { chapterNumber: 1, plainText: 'Untouched live chapter prose.' });

    const bundle = await createNovelBackup(alice.id, novel.id);

    // Tamper with the chapter title without updating the SHA-256 checksum
    const tampered = structuredClone(bundle);
    tampered.data.novel.title = 'Tampered Title';

    await expect(
      restoreNovelBackup(alice.id, tampered, { targetNovelId: novel.id }),
    ).rejects.toThrow(/checksum mismatch/i);

    // Verify incompatible version is rejected
    const futureVersion = structuredClone(bundle);
    (futureVersion.manifest as any).formatVersion = 99;
    await expect(
      restoreNovelBackup(alice.id, futureVersion, { targetNovelId: novel.id }),
    ).rejects.toThrow(/Unsupported backup format version/i);

    // Verify live novel data is completely intact
    const liveNovel = db().prepare('SELECT title FROM novels WHERE id = ?').get(novel.id) as any;
    expect(liveNovel.title).toBe('Original Untouched Novel');
    const liveChapter = db().prepare('SELECT plainText FROM chapters WHERE novelId = ?').get(novel.id) as any;
    expect(liveChapter.plainText).toBe('Untouched live chapter prose.');
  });

  it('restores a backup into a new novel or overwrites an existing owned novel via API routes', async () => {
    const alice = seedUser();
    const bob = seedUser();
    const novel = seedNovel(alice.id, { title: 'Chronicles of Glass' });
    seedOutline(novel.id, 2);
    const ch1 = seedChapter(novel.id, { chapterNumber: 1, plainText: 'Chapter one original text.' });
    await createVersion(alice.id, novel.id, ch1, 'Saved v1');

    session.userId = alice.id;

    // Download backup via GET /api/novels/[id]/backup?download=1
    const dlRes = await getBackupRoute(
      jsonRequest(`/api/novels/${novel.id}/backup?download=1`),
      { params: { id: novel.id } },
    );
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('content-disposition')).toContain('chronicles-of-glass-backup.json');
    const bundle = await readJson(dlRes);

    // Cross-user backup download is rejected with 404
    session.userId = bob.id;
    const bobGet = await getBackupRoute(
      jsonRequest(`/api/novels/${novel.id}/backup`),
      { params: { id: novel.id } },
    );
    expect(bobGet.status).toBe(404);

    // Restore as a new copy for Alice via POST /api/novels/restore
    session.userId = alice.id;
    const restoreNewRes = await postRestoreRoute(
      jsonRequest('/api/novels/restore', { bundle }),
    );
    expect(restoreNewRes.status).toBe(201);
    const restoredNew = await readJson(restoreNewRes);
    expect(restoredNew.novelId).not.toBe(novel.id);
    expect(restoredNew.chaptersRestored).toBe(1);
    expect(restoredNew.versionsRestored).toBe(1);

    // Modify the original novel, then restore the backup over it via POST /api/novels/[id]/backup
    db().prepare('UPDATE novels SET title = ? WHERE id = ?').run('Temporary Changed Title', novel.id);
    const overwriteRes = await postNovelBackupRoute(
      jsonRequest(`/api/novels/${novel.id}/backup`, bundle),
      { params: { id: novel.id } },
    );
    expect(overwriteRes.status).toBe(200);
    const rowAfter = db().prepare('SELECT title FROM novels WHERE id = ?').get(novel.id) as any;
    expect(rowAfter.title).toBe('Chronicles of Glass');
  });

  it('performs an online SQLite database file backup using SQLite backup API', async () => {
    const alice = seedUser();
    seedNovel(alice.id, { title: 'SQLite Backup Verification' });

    const tmpFile = path.join(os.tmpdir(), `novelforge-backup-${Date.now()}.db`);
    try {
      const result = await backupSqliteDatabaseFile(tmpFile);
      expect(result.path).toBe(tmpFile);
      const stat = fs.statSync(tmpFile);
      expect(stat.size).toBeGreaterThan(4096);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });
});
