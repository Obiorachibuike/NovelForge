/**
 * Migrates an existing NovelForge SQLite database into PostgreSQL.
 *
 * Usage:
 *   DATABASE_URL="postgresql://user:pass@host:5432/novelforge" \
 *   SQLITE_SOURCE_PATH="./prisma/dev.db" \
 *   npm run db:migrate:sqlite-to-pg
 */
import path from 'node:path';
import { isPostgresUrl, closePgPool } from '../src/lib/db/postgres';
import { migrateSqliteToPostgres } from '../src/lib/db/sqlite-to-postgres';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!isPostgresUrl(databaseUrl)) {
    console.error(
      'error: DATABASE_URL must be set to a PostgreSQL connection string (postgresql://...) to run SQLite-to-PostgreSQL migration.',
    );
    process.exitCode = 1;
    return;
  }

  const rawSource = process.env.SQLITE_SOURCE_PATH || process.env.SQLITE_PATH || './prisma/dev.db';
  const sqlitePath = path.isAbsolute(rawSource)
    ? rawSource
    : path.join(process.cwd(), rawSource.replace(/^file:/, '').replace(/^\.\//, ''));

  try {
    const report = await migrateSqliteToPostgres({
      sqlitePath,
      log: msg => console.log(msg),
    });
    const totalRows = report.tables.reduce((sum, t) => sum + t.migratedCount, 0);
    console.log(
      `[migrate] Completed SQLite -> PostgreSQL migration (${totalRows} row(s) across ${report.tables.length} tables).`,
    );
  } catch (err: any) {
    console.error(`error: ${err?.message || String(err)}`);
    process.exitCode = 1;
  } finally {
    await closePgPool();
  }
}

void main();
