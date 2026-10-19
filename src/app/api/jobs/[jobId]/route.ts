import { requireUser, requireJob } from '@/lib/db/ownership';
import { getJob, serializeJob, cancelJob, retryJob } from '@/lib/queue';
import { apiHandler, HttpError, readJsonBody } from '@/lib/api/http';
import { z } from 'zod';

const jobActionSchema = z.object({
  action: z.enum(['cancel', 'retry']),
});

/**
 * Job status, cancellation and retry for the authenticated owner.
 */
export const GET = apiHandler(async (_req: Request, ctx: { params: { jobId: string } }) => {
  const user = await requireUser();
  const owned = await requireJob(ctx.params.jobId, user.id);
  const job = await getJob(owned.id);
  if (!job) throw new HttpError(404, 'Job not found', 'job_not_found');
  return Response.json(serializeJob(job));
});

export const POST = apiHandler(async (req: Request, ctx: { params: { jobId: string } }) => {
  const user = await requireUser();
  const owned = await requireJob(ctx.params.jobId, user.id);
  const body = await readJsonBody(req, v => jobActionSchema.parse(v));

  if (body.action === 'cancel') {
    const cancelled = cancelJob(owned.id);
    if (!cancelled) {
      throw new HttpError(409, 'Job is no longer active and cannot be cancelled.', 'job_not_cancellable');
    }
    const updated = await getJob(owned.id);
    return Response.json({ ok: true, job: updated ? serializeJob(updated) : null });
  }

  const retried = await retryJob(owned.id);
  if (!retried) {
    throw new HttpError(409, 'Only failed or cancelled jobs can be retried.', 'job_not_retryable');
  }
  const updated = await getJob(owned.id);
  return Response.json({ ok: true, job: updated ? serializeJob(updated) : null });
});

export const DELETE = apiHandler(async (_req: Request, ctx: { params: { jobId: string } }) => {
  const user = await requireUser();
  const owned = await requireJob(ctx.params.jobId, user.id);
  const cancelled = cancelJob(owned.id);
  if (!cancelled) {
    throw new HttpError(409, 'Job is no longer active and cannot be cancelled.', 'job_not_cancellable');
  }
  const updated = await getJob(owned.id);
  return Response.json({ ok: true, job: updated ? serializeJob(updated) : null });
});
