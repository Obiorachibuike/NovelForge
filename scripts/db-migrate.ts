/**
 * Applies pending database migrations.
 *
 *   npm run db:migrate          # apply
 *   npm run db:status           # report applied/pending without changing anything
 *
 * The default DATABASE_URL targets the local SQLite file; set DATABASE_URL to
 * your production database before running it against a deployed environment.
 */
import { migrateDatabase, databaseStatus, closeDb } from '../src/lib/db';

const mode = process.argv.includes('--status') ? 'status' : 'migrate';

try {
  if (mode === 'status') {
    const status = databaseStatus();
    console.log(`driver:   ${status.driver}`);
    console.log(`database: ${status.path}`);
    console.log(`applied:  ${status.applied.map(a => a.id).join(', ') || '(none)'}`);
    console.log(`pending:  ${status.pending.join(', ') || '(none)'}`);
    if (status.pending.length) process.exitCode = 1;
  } else {
    const result = migrateDatabase();
    console.log(`applied:  ${result.applied.join(', ') || '(none)'}`);
    console.log(`already:  ${result.skipped.length} migration(s)`);
  }
} catch (err) {
  // Configuration problems are printed without a stack trace: the message is
  // the actionable part (see docs/postgresql.md / docs/storage.md).
  if (err instanceof Error && (err.name === 'DatabaseConfigurationError' || /not set|not implemented/i.test(err.message))) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  closeDb();
}
