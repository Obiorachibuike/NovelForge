import { requireUser } from '@/lib/db/ownership';
import { apiHandler, HttpError } from '@/lib/api/http';
import {
  deleteGeneration,
  getGenerationForUser,
  serializeGeneration,
} from '@/lib/jobs/generation-jobs';
// Importing the chapter service registers generation handlers in runtimes that
// read a job (e.g. a single-process deployment using the database transport).
import '@/services/chapters/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/generations/[jobId] — owner-only generation details. */
export const GET = apiHandler(async (_req: Request, ctx: { params: { jobId: string } }) => {
  const user = await requireUser();
  const job = getGenerationForUser(user.id, ctx.params.jobId);
  if (!job) throw new HttpError(404, 'Generation not found', 'generation_not_found');
  return Response.json(
    { generation: serializeGeneration(job) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});

/**
 * DELETE /api/generations/[jobId] — remove one task from the queue/history.
 *
 * Owner-scoped. Any state can be deleted: an active task is cancelled first
 * (its content is never written over existing prose) and the row plus its
 * durable events are removed from the queue.
 */
export const DELETE = apiHandler(async (_req: Request, ctx: { params: { jobId: string } }) => {
  const user = await requireUser();
  const result = await deleteGeneration(user.id, ctx.params.jobId);
  return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
});
