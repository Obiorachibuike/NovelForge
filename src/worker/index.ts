/**
 * Standalone worker process entrypoint. Running `npm run worker` imports all
 * service modules (which register their job handlers against the in-process
 * queue) and then drains any queued jobs from the database.
 *
 * When QUEUE_PROVIDER=redis this module can be extended to boot BullMQ workers;
 * by default it uses the SQLite-backed in-process queue for simplicity.
 */
import { getDb } from '@/lib/db';
import { initQueue, runJob } from '@/lib/queue';

// Import all services so their registerHandler calls execute
import '@/services/images/service';
import '@/services/preparation/service';
import '@/services/outlines/service';
import '@/services/chapters/service';
import '@/services/consistency/service';
import '@/services/exports/service';

async function main() {
  const db = getDb();
  console.log('[worker] connected to db');
  initQueue();

  // Simple polling loop for any queued jobs (in-process mode is immediate; this handles restarts)
  setInterval(() => {
    const jobs = db.prepare(`SELECT id FROM generation_jobs WHERE status='queued' ORDER BY createdAt ASC LIMIT 5`).all() as any[];
    for (const j of jobs) runJob(j.id).catch(err => console.error('[worker] job error', j.id, err));
  }, 3000);

  console.log('[worker] listening for jobs');
}

main().catch(err => { console.error('[worker] fatal', err); process.exit(1); });
