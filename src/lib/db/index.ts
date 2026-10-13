import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import 'server-only';
import { runMigrations, migrationStatus, type MigrationResult } from './migrations';

let _db: Database.Database | null = null;

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigurationError';
  }
}

/**
 * SQLite is the only implemented database driver.
 *
 * `DATABASE_URL` accepts a SQLite URL (`file:./prisma/dev.db`) or a bare path.
 * A `postgres://` / `postgresql://` URL is rejected loudly instead of being
 * silently interpreted as a filename — see docs/postgresql.md for the migration
 * procedure that is still required before PostgreSQL can be used.
 */
export function resolveSqlitePath(url = process.env.DATABASE_URL || 'file:./prisma/dev.db'): string {
  if (/^postgres(ql)?:\/\//i.test(url)) {
    throw new DatabaseConfigurationError(
      'DATABASE_URL is a PostgreSQL URL but this build only ships a SQLite driver. ' +
        'NovelForge would otherwise create a file called "postgres://…" in the working directory. ' +
        'Either run with a SQLite URL (file:./prisma/dev.db) on a host with a persistent disk, ' +
        'or complete the PostgreSQL adapter work described in docs/postgresql.md.',
    );
  }
  if (/^mysql:\/\//i.test(url)) {
    throw new DatabaseConfigurationError('DATABASE_URL points at MySQL, which NovelForge does not support.');
  }
  const filePath = url.startsWith('file:') ? url.slice(5) : url;
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath.replace(/^\.\//, ''));
}

/**
 * Returns the shared, migrated SQLite handle. The schema is initialised by the
 * versioned migrations in ./migrations (tracked in `schema_migrations`) so that
 * additive changes to an existing deployment are applied exactly once.
 */
export function getDb(): Database.Database {
  if (_db) return _db;

  const absPath = resolveSqlitePath();
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  const db = new Database(absPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db, msg => console.log(msg));
  _db = db;
  return db;
}

/** Runs pending migrations against the configured database (used by `npm run db:migrate`). */
export function migrateDatabase(): MigrationResult & { pendingBefore: string[] } {
  const db = getDb();
  const before = migrationStatus(db).pending;
  const result = runMigrations(db, msg => console.log(msg));
  return { ...result, pendingBefore: before };
}

export function databaseStatus() {
  const db = getDb();
  const { applied, pending } = migrationStatus(db);
  const url = process.env.DATABASE_URL || 'file:./prisma/dev.db';
  return { driver: 'sqlite', url, path: resolveSqlitePath(url), applied, pending };
}

/** Closes the cached handle. Used by scripts and tests; a no-op when never opened. */
export function closeDb() {
  if (_db) {
    try { _db.close(); } catch { /* already closed */ }
    _db = null;
  }
}

/** Test-only helper: drops the cached handle so a new DATABASE_URL is honoured. */
export function resetDbForTests() {
  closeDb();
}
