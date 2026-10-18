/**
 * Apply pending NovelForge schema migrations, or inspect status with `--status`.
 * Supports both PostgreSQL (`DATABASE_URL=postgresql://...`) and SQLite.
 *
 *   npm run db:migrate
 *   npm run db:status
 */
import { databaseStatus, migrateDatabase, closeDb, activeDatabaseDriver, resolveSqlitePath } from '../src/lib/db';
import { getPgPool, redactConnectionString, runPostgresMigrations, postgresMigrationStatus, closePgPool } from '../src/lib/db/postgres';

const statusOnly = process.argv.includes('--status');

async function main() {
  const driver = activeDatabaseDriver();

  if (driver === 'postgres') {
    const pool = getPgPool();
    const redacted = redactConnectionString(process.env.DATABASE_URL || '');
    if (!statusOnly) {
      await runPostgresMigrations(pool, (msg) => console.log(msg));
    }
    const status = await postgresMigrationStatus(pool);
    console.log(`Database driver: postgres (${redacted})`);
    console.log(`\nApplied migrations (${status.applied.length}):`);
    for (const m of status.applied) {
      console.log(`  ✓ ${m.id}  (${m.appliedAt})`);
    }
    if (status.pending.length === 0) {
      console.log('\nSchema is up to date.');
    } else {
      console.log(`\nPending migrations (${status.pending.length}):`);
      for (const id of status.pending) {
        console.log(`  • ${id}`);
      }
      if (statusOnly) {
        process.exitCode = 1;
      }
    }
    await closePgPool();
    closeDb();
    return;
  }

  if (!statusOnly) {
    migrateDatabase();
  }

  const status = databaseStatus();
  console.log(`Database driver: sqlite (${resolveSqlitePath()})`);
  console.log(`\nApplied migrations (${status.applied.length}):`);
  for (const m of status.applied) {
    console.log(`  ✓ ${m.id}  (${m.appliedAt})`);
  }

  if (status.pending.length === 0) {
    console.log('\nSchema is up to date.');
  } else {
    console.log(`\nPending migrations (${status.pending.length}):`);
    for (const id of status.pending) {
      console.log(`  • ${id}`);
    }
    if (statusOnly) {
      process.exitCode = 1;
    }
  }

  closeDb();
}

main().catch((err) => {
  console.error('[db:migrate] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
