import { requireUser, requireJob } from '@/lib/db/ownership';
import { apiHandler, HttpError, readJsonBody } from '@/lib/api/http';
import { cancelJob, getJob, retryJob, serializeJob } from '@/lib/queue';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const actionSchema = z.object({ action: z.enum(['cancel', 'retry']) });

/** Job status with model provenance (owner only). */
export const GET = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  const owned = await requireJob(ctx.params.id, user.id);
  const job = await getJob(owned.id);
  if (!job) throw new HttpError(404, 'Job not found', 'job_not_found');
  return Response.json({
    job: {
      ...serializeJob(job),
      requestedModel: (job as any).requestedModel ?? null,
      actualModel: (job as any).actualModel ?? null,
      provider: (job as any).provider ?? null,
      fallbackCount: (job as any).fallbackCount ?? 0,
      durationMs: (job as any).durationMs ?? null,
    },
  });
});

/** Cancel or retry one of the caller's own jobs. */
export const POST = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  const owned = await requireJob(ctx.params.id, user.id);
  const body = await readJsonBody(req, v => actionSchema.parse(v));

  if (body.action === 'cancel') {
    if (!cancelJob(owned.id)) {
      throw new HttpError(409, 'Job is no longer active and cannot be cancelled.', 'job_not_cancellable');
    }
  } else if (!(await retryJob(owned.id))) {
    throw new HttpError(409, 'Only failed or cancelled jobs can be retried.', 'job_not_retryable');
  }

  const updated = await getJob(owned.id);
  return Response.json({ ok: true, job: updated ? serializeJob(updated) : null });
});
