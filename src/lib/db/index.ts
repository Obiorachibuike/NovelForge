import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import 'server-only';
import { runMigrations, migrationStatus, type MigrationResult } from './migrations';
import {
  isPostgresUrl,
  parsePostgresConfig,
  redactConnectionString,
  getPgPool,
  closePgPool,
  pgQuery,
  pgQueryOne,
  pgExecute,
  withPgTransaction,
  runPostgresMigrations,
  postgresMigrationStatus,
  checkPostgresHealth,
  translateSqlForPostgres,
  normalizePgRow,
  __setPgPoolForTests,
} from './postgres';
import {
  createPostgresSyncDatabase,
  runMigrationsOnSyncPg,
  __setPgSyncExecutorFactoryForTests,
} from './postgres-sync-bridge';

export {
  isPostgresUrl,
  parsePostgresConfig,
  redactConnectionString,
  getPgPool,
  closePgPool,
  pgQuery,
  pgQueryOne,
  pgExecute,
  withPgTransaction,
  runPostgresMigrations,
  postgresMigrationStatus,
  checkPostgresHealth,
  translateSqlForPostgres,
  normalizePgRow,
  __setPgPoolForTests,
  __setPgSyncExecutorFactoryForTests,
};

let _db: Database.Database | null = null;

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigurationError';
  }
}

export function activeDatabaseDriver(url = process.env.DATABASE_URL): 'postgres' | 'sqlite' {
  const isProdRuntime =
    process.env.NODE_ENV === 'production' &&
    process.env.NEXT_PHASE !== 'phase-production-build';

  if (url && /^mysql:\/\//i.test(url.trim())) {
    throw new DatabaseConfigurationError('DATABASE_URL points at MySQL, which NovelForge does not support. Use PostgreSQL (postgresql://...).');
  }

  if (isPostgresUrl(url)) {
    parsePostgresConfig(url);
    return 'postgres';
  }

  if (isProdRuntime && process.env.ALLOW_SQLITE_IN_PRODUCTION !== 'true') {
    if (!url || !url.trim()) {
      throw new DatabaseConfigurationError(
        'DATABASE_URL is required in production and must be a PostgreSQL connection string (postgresql://...). Never silently falling back to SQLite.',
      );
    }
    throw new DatabaseConfigurationError(
      'Production requires a PostgreSQL DATABASE_URL (postgresql://...). SQLite fallback is disabled in production unless ALLOW_SQLITE_IN_PRODUCTION=true is explicitly set.',
    );
  }

  return 'sqlite';
}

/**
 * Resolves a local SQLite file path for development, testing, or SQLite-to-PostgreSQL
 * data migration. Rejects `postgres://` and `mysql://` URLs so a connection URL is
 * never accidentally treated as a local filename on disk.
 */
export function resolveSqlitePath(url = process.env.DATABASE_URL || 'file:./prisma/dev.db'): string {
  if (/^postgres(ql)?:\/\//i.test(url)) {
    throw new DatabaseConfigurationError(
      'resolveSqlitePath() called with a PostgreSQL URL. Use getDb() or getPgPool() for PostgreSQL connections.',
    );
  }
  if (/^mysql:\/\//i.test(url)) {
    throw new DatabaseConfigurationError('DATABASE_URL points at MySQL, which NovelForge does not support.');
  }
  const filePath = url.startsWith('file:') ? url.slice(5) : url;
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath.replace(/^\.\//, ''));
}

/**
 * Returns the shared, migrated database handle.
 *
 * - When `DATABASE_URL` is a `postgres://` / `postgresql://` URL, connects to
 *   PostgreSQL (the primary production database) and applies versioned migrations.
 * - In local development / unit tests when `DATABASE_URL` is a `file:` path,
 *   opens SQLite with WAL and foreign keys enabled.
 */
export function getDb(): Database.Database {
  if (_db) return _db;

  const url = process.env.DATABASE_URL;
  const driver = activeDatabaseDriver(url);

  if (driver === 'postgres') {
    _db = createPostgresSyncDatabase(url!, msg => console.log(msg));
    return _db!;
  }

  const absPath = resolveSqlitePath(url || 'file:./prisma/dev.db');
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
export function migrateDatabase(): MigrationResult & { pendingBefore: string[]; driver: 'postgres' | 'sqlite' } {
  const driver = activeDatabaseDriver(process.env.DATABASE_URL);
  const db = getDb();
  const before = migrationStatus(db).pending;
  const result = driver === 'postgres'
    ? runMigrationsOnSyncPg(db, msg => console.log(msg))
    : runMigrations(db, msg => console.log(msg));
  return { ...result, pendingBefore: before, driver };
}

export function databaseStatus() {
  const url = process.env.DATABASE_URL || 'file:./prisma/dev.db';
  const driver = activeDatabaseDriver(url);
  const db = getDb();
  const { applied, pending } = migrationStatus(db);
  return {
    driver,
    url: redactConnectionString(url),
    path: driver === 'postgres' ? redactConnectionString(url) : resolveSqlitePath(url),
    applied,
    pending,
  };
}

/** Closes the cached handle and any active PostgreSQL pool. */
export function closeDb() {
  if (_db) {
    try { _db.close(); } catch { /* already closed */ }
    _db = null;
  }
  void closePgPool();
}

/** Test-only helper: drops the cached handle so a new DATABASE_URL is honoured. */
export function resetDbForTests() {
  closeDb();
}
