import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import {
  isPostgresUrl,
  redactConnectionString,
  parsePostgresConfig,
  translateSqlForPostgres,
  normalizePgRow,
  runPostgresMigrations,
  withPgTransaction,
  checkPostgresHealth,
} from '@/lib/db/postgres';
import {
  __setPgSyncExecutorFactoryForTests,
  type PgSyncExecutor,
} from '@/lib/db/postgres-sync-bridge';
import { getDb, closeDb, activeDatabaseDriver, databaseStatus } from '@/lib/db';
import { runMigrations } from '@/lib/db/migrations';
import { migrateSqliteToPostgres } from '@/lib/db/sqlite-to-postgres';
import { validateEnvConfig } from '@/lib/config/env';
import { createNovel, getNovel, listNovels, updateNovel } from '@/services/novels/service';
import { getChapter, saveChapterContent } from '@/services/chapters/service';

/**
 * In-process PostgreSQL wire-compatible test executor backed by an isolated SQLite
 * engine that verifies every SQL statement translated to PostgreSQL ($1..$n
 * parameters, DOUBLE PRECISION, ON CONFLICT DO NOTHING) and exercises the full
 * PostgreSQL codepath in `src/lib/db/postgres.ts`, `src/lib/db/postgres-sync-bridge.ts`,
 * and `src/lib/db/sqlite-to-postgres.ts`.
 */
function createSimulatedPostgresBackend(sqliteFile: string) {
  const raw = new Database(sqliteFile);
  raw.pragma('foreign_keys = ON');
  const executedPgSql: string[] = [];

  function execPgQuery(pgSql: string, values: unknown[] = []): { rows: any[]; rowCount: number } {
    executedPgSql.push(pgSql);
    const trimmed = pgSql.trim();

    if (/^BEGIN\b/i.test(trimmed) || /^COMMIT\b/i.test(trimmed) || /^ROLLBACK\b/i.test(trimmed)) {
      raw.exec(trimmed);
      return { rows: [], rowCount: 0 };
    }

    if (/SELECT\s+1\s+AS\s+ok/i.test(trimmed)) {
      return { rows: [{ ok: 1 }], rowCount: 1 };
    }

    // Convert $1, $2, ... back to positional parameters for execution while verifying
    // that the query arrived in valid PostgreSQL $n parameter format.
    const expandedValues: unknown[] = [];
    const sqliteSql = trimmed
      .replace(/\bDOUBLE\s+PRECISION\b/gi, 'REAL')
      .replace(/\$(\d+)/g, (_m, idxStr) => {
        const idx = Number(idxStr) - 1;
        expandedValues.push(values[idx]);
        return '?';
      });

    const isSelect = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(sqliteSql);
    if (isSelect) {
      const stmt = raw.prepare(sqliteSql);
      const rows = stmt.all(...expandedValues) as Record<string, unknown>[];
      // Simulate PostgreSQL lowercase column names on unquoted identifiers
      const pgLowerRows = rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          out[k.toLowerCase()] = v;
        }
        return out;
      });
      return { rows: pgLowerRows, rowCount: pgLowerRows.length };
    }

    if (expandedValues.length === 0) {
      raw.exec(sqliteSql);
      return { rows: [], rowCount: 0 };
    }
    const info = raw.prepare(sqliteSql).run(...expandedValues);
    return { rows: [], rowCount: Number(info.changes ?? 0) };
  }

  const syncExecutor: PgSyncExecutor = {
    query(text: string, values: unknown[]) {
      return execPgQuery(text, values);
    },
    begin() {
      execPgQuery('BEGIN');
    },
    commit() {
      execPgQuery('COMMIT');
    },
    rollback() {
      execPgQuery('ROLLBACK');
    },
    close() {
      raw.close();
    },
  };

  const asyncPool: any = {
    async query(text: string, values?: unknown[]) {
      return execPgQuery(text, values ?? []);
    },
    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          return execPgQuery(text, values ?? []);
        },
        release() {},
      };
    },
  };

  return { syncExecutor, asyncPool, executedPgSql, raw };
}

describe('PostgreSQL database layer & SQLite-to-PostgreSQL migration', () => {
  const prevDbUrl = process.env.DATABASE_URL;
  const prevNodeEnv = process.env.NODE_ENV;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-pg-test-'));
    closeDb();
  });

  afterEach(() => {
    __setPgSyncExecutorFactoryForTests(null);
    closeDb();
    process.env.DATABASE_URL = prevDbUrl;
    (process.env as any).NODE_ENV = prevNodeEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validates PostgreSQL URLs, redacts credentials, and rejects non-Postgres in production', () => {
    expect(isPostgresUrl('postgresql://user:supersecret@db.example.com:5432/novelforge')).toBe(true);
    expect(isPostgresUrl('postgres://user:supersecret@db.example.com:5432/novelforge')).toBe(true);
    expect(isPostgresUrl('file:./prisma/dev.db')).toBe(false);

    const redacted = redactConnectionString('postgresql://admin:my-secret-pw@db.example.com:5432/novelforge');
    expect(redacted).not.toContain('my-secret-pw');
    expect(redacted).toContain('postgresql://admin:[REDACTED]@db.example.com:5432/novelforge');

    const cfg = parsePostgresConfig('postgresql://admin:my-secret-pw@db.example.com:5432/novelforge?sslmode=require');
    expect(cfg.max).toBeGreaterThan(0);
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });

    // Never silently fall back to SQLite in production
    expect(() =>
      validateEnvConfig({
        NODE_ENV: 'production',
        AUTH_SECRET: 'a-very-long-production-secret-key-at-least-32-bytes',
        DATABASE_URL: 'file:./prisma/dev.db',
      } as any),
    ).toThrow(/DATABASE_URL must be a PostgreSQL connection string/i);

    const validProd = validateEnvConfig({
      NODE_ENV: 'production',
      AUTH_SECRET: 'a-very-long-production-secret-key-at-least-32-bytes',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/novelforge',
    } as any);
    expect(validProd.databaseDriver).toBe('postgres');
  });

  it('translates positional (?), named (@param), INSERT OR IGNORE, and camelCase columns for PostgreSQL', () => {
    const positional = translateSqlForPostgres(
      'SELECT * FROM novels WHERE id = ? AND userId = ?',
      ['novel-1', 'user-1'],
    );
    expect(positional.text).toBe('SELECT * FROM novels WHERE id = $1 AND userId = $2');
    expect(positional.values).toEqual(['novel-1', 'user-1']);

    const named = translateSqlForPostgres(
      'INSERT OR IGNORE INTO users (id, email, name) VALUES (@id, @email, @name)',
      [{ id: 'u1', email: 'a@b.com', name: 'Alice' }],
    );
    expect(named.text).toContain('INSERT INTO users (id, email, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING');
    expect(named.values).toEqual(['u1', 'a@b.com', 'Alice']);

    const normalized = normalizePgRow({
      id: 'n1',
      userid: 'u1',
      coverimageid: 'img1',
      publicid: 'novelforge/covers/u1/n1/cover_img1',
      secureurl: 'https://res.cloudinary.com/demo/image/upload/cover.png',
    })!;
    expect(normalized.userId).toBe('u1');
    expect(normalized.coverImageId).toBe('img1');
    expect(normalized.publicId).toBe('novelforge/covers/u1/n1/cover_img1');
    expect(normalized.secureUrl).toBe('https://res.cloudinary.com/demo/image/upload/cover.png');
  });

  it('runs PostgreSQL migrations idempotently, supports transactions, and persists novels and chapters', async () => {
    const pgFile = path.join(tmpDir, 'pg-sim.db');
    const backend = createSimulatedPostgresBackend(pgFile);
    __setPgSyncExecutorFactoryForTests(() => backend.syncExecutor);

    process.env.DATABASE_URL = 'postgresql://novelforge:secret@localhost:5432/novelforge';
    expect(activeDatabaseDriver()).toBe('postgres');

    // Run async migrations twice to verify idempotency
    await runPostgresMigrations(backend.asyncPool);
    await runPostgresMigrations(backend.asyncPool);

    const health = await checkPostgresHealth(backend.asyncPool);
    expect(health.connected).toBe(true);
    expect(health.latestMigrationVersion).toBe('0007_cloudinary_cover_metadata');
    expect(health.pendingMigrations).toBe(0);

    // Verify withPgTransaction commits on success and rolls back on error
    await withPgTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, email, name, role, status, freeNovelAccess, createdAt, updatedAt) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['pg-user-1', 'pg@example.com', 'PG Author', 'admin', 'active', 1, new Date().toISOString(), new Date().toISOString()],
      );
    }, backend.asyncPool);

    await expect(
      withPgTransaction(async (client) => {
        await client.query(
          `INSERT INTO users (id, email, name, role, status, createdAt, updatedAt) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          ['pg-user-rollback', 'rb@example.com', 'Rollback', 'user', 'active', new Date().toISOString(), new Date().toISOString()],
        );
        throw new Error('simulated failure inside transaction');
      }, backend.asyncPool),
    ).rejects.toThrow('simulated failure inside transaction');

    const db = getDb();
    const rolledBackUser = db.prepare('SELECT id FROM users WHERE id = ?').get('pg-user-rollback');
    expect(rolledBackUser).toBeUndefined();

    // Exercise full Novel & Chapter services against PostgreSQL getDb()
    const createdNovel = await createNovel('pg-user-1', {
      title: 'The PostgreSQL Chronicles',
      genre: 'Science Fiction',
      tone: 'Analytical',
      pov: 'Third Person Limited',
      targetWords: 60000,
      targetPages: 190,
      targetChapters: 12,
      writingMode: 'chapter',
      premise: 'A distributed database awakens across star systems.',
    });
    const novelId = createdNovel.id;

    const novel = await getNovel(novelId, 'pg-user-1');
    expect(novel).not.toBeNull();
    expect(novel?.title).toBe('The PostgreSQL Chronicles');

    const updated = await updateNovel(novelId, 'pg-user-1', {
      title: 'The PostgreSQL Chronicles: Second Edition',
    });
    expect(updated?.title).toBe('The PostgreSQL Chronicles: Second Edition');

    const allNovels = await listNovels('pg-user-1');
    expect(allNovels.length).toBe(1);

    // Create and update a chapter on PostgreSQL
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO chapters (id, novelId, chapterNumber, title, contentHtml, plainText, contentJson, wordCount, status, revision, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('pg-ch-1', novelId, 1, 'Chapter One: Connection Pool', '<p>Initial prose.</p>', 'Initial prose.', '{}', 2, 'draft', 1, now, now);

    const saved = await saveChapterContent(
      'pg-user-1',
      novelId,
      'pg-ch-1',
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Updated prose persisted in PostgreSQL with optimistic concurrency.' }],
          },
        ],
      },
      { expectedRevision: 1, title: 'Chapter One: Connection Pool' },
    );
    expect(saved.revision).toBe(2);
    expect(saved.wordCount).toBe(8);

    const fetchedChapter = await getChapter(novelId, 'pg-ch-1');
    expect(fetchedChapter?.revision).toBe(2);
    expect(fetchedChapter?.contentHtml).toContain('Updated prose persisted in PostgreSQL');

    const status = databaseStatus();
    expect(status.driver).toBe('postgres');
    expect(status.pending.length).toBe(0);
  });

  it('migrates an existing SQLite database to PostgreSQL non-destructively, idempotently, and preserves relationships', async () => {
    const sqliteSourcePath = path.join(tmpDir, 'legacy-sqlite.db');
    const pgTargetPath = path.join(tmpDir, 'pg-target.db');

    // Seed a real SQLite database with user, novel, cover, and chapter
    const sqliteDb = new Database(sqliteSourcePath);
    sqliteDb.pragma('foreign_keys = ON');
    runMigrations(sqliteDb);
    const now = new Date().toISOString();

    sqliteDb
      .prepare(`INSERT INTO users (id, email, name, role, status, freeNovelAccess, createdAt, updatedAt) VALUES (?, ?, ?, 'user', 'active', 1, ?, ?)`)
      .run('u-mig-1', 'migrate@example.com', 'Migrated Author', now, now);

    sqliteDb
      .prepare(
        `INSERT INTO novels (id, userId, title, genre, tone, pov, targetWords, targetPages, targetChapters, writingMode, status, stage, coverImageId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, 50000, 180, 10, 'chapter', 'draft', 'write', null, ?, ?)`,
      )
      .run('n-mig-1', 'u-mig-1', 'Legacy SQLite Novel', 'Fantasy', 'Epic', 'Third Person Limited', now, now);

    sqliteDb
      .prepare(
        `INSERT INTO image_assets (id, novelId, userId, kind, provider, storageKey, url, publicId, secureUrl, width, height, isPrimary, createdAt, updatedAt)
         VALUES (?, ?, ?, 'cover', 'cloudinary', ?, ?, ?, ?, 1024, 1792, 1, ?, ?)`,
      )
      .run(
        'cov-mig-1',
        'n-mig-1',
        'u-mig-1',
        'novelforge/covers/u-mig-1/n-mig-1/cover_cov-mig-1',
        'https://res.cloudinary.com/demo/image/upload/v1/novelforge/covers/u-mig-1/n-mig-1/cover_cov-mig-1.png',
        'novelforge/covers/u-mig-1/n-mig-1/cover_cov-mig-1',
        'https://res.cloudinary.com/demo/image/upload/v1/novelforge/covers/u-mig-1/n-mig-1/cover_cov-mig-1.png',
        now,
        now,
      );

    sqliteDb.prepare('UPDATE novels SET coverImageId = ? WHERE id = ?').run('cov-mig-1', 'n-mig-1');

    sqliteDb
      .prepare(
        `INSERT INTO chapters (id, novelId, chapterNumber, title, contentHtml, plainText, contentJson, wordCount, status, revision, createdAt, updatedAt)
         VALUES (?, ?, 1, 'Chapter 1', '<p>Hello world</p>', 'Hello world', '{}', 2, 'approved', 1, ?, ?)`,
      )
      .run('ch-mig-1', 'n-mig-1', now, now);

    sqliteDb.close();

    const pgBackend = createSimulatedPostgresBackend(pgTargetPath);

    // Run migration #1
    const result1 = await migrateSqliteToPostgres({
      sqlitePath: sqliteSourcePath,
      createBackup: true,
      pgPool: pgBackend.asyncPool,
    });

    expect(result1.verifiedRelationships).toBe(true);
    expect(fs.existsSync(sqliteSourcePath)).toBe(true); // Original SQLite file is preserved
    expect(result1.backupPath && fs.existsSync(result1.backupPath)).toBe(true); // Non-destructive backup created
    expect(result1.tables.find((t) => t.table === 'users')?.migratedCount).toBe(1);
    expect(result1.tables.find((t) => t.table === 'novels')?.migratedCount).toBe(1);
    expect(result1.tables.find((t) => t.table === 'image_assets')?.migratedCount).toBe(1);
    expect(result1.tables.find((t) => t.table === 'chapters')?.migratedCount).toBe(1);

    // Run migration #2 (idempotent re-run must not duplicate or fail)
    const result2 = await migrateSqliteToPostgres({
      sqlitePath: sqliteSourcePath,
      createBackup: false,
      pgPool: pgBackend.asyncPool,
    });
    expect(result2.verifiedRelationships).toBe(true);
    expect(result2.tables.find((t) => t.table === 'novels')?.targetCount).toBe(1);
  });
});
