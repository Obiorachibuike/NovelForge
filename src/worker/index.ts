/**
 * Standalone background worker entry point.
 *
 *   npm run worker        # production: pg-boss consumer + database recovery sweep
 *   npm run worker:dev    # same, restarted on source changes
 *
 * This process is what makes chapter generation survive the browser tab, the
 * Next.js runtime and even a worker restart: every job is a row in PostgreSQL
 * and pg-boss only carries wake-ups.
 */
import { startWorker } from '@/lib/jobs/worker';

async function main() {
  const worker = await startWorker();

  const shutdown = (signal: string) => {
    void worker.stop(signal).then(
      () => process.exit(0),
      err => {
        console.error('[worker] shutdown failed', err);
        process.exit(1);
      },
    );
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', reason => {
    console.error('[worker] unhandled rejection', reason);
  });
}

main().catch(err => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
