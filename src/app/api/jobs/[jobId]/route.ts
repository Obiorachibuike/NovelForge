import { requireUser, requireJob } from '@/lib/db/ownership';
import { getJob, serializeJob } from '@/lib/queue';
import { apiHandler, HttpError } from '@/lib/api/http';

/**
 * Job status for the authenticated owner (used by the writing workspace to
 * follow generation progress and to surface failures).
 */
export const GET = apiHandler(async (_req: Request, ctx: { params: { jobId: string } }) => {
  const user = await requireUser();
  const owned = await requireJob(ctx.params.jobId, user.id);
  const job = await getJob(owned.id);
  if (!job) throw new HttpError(404, 'Job not found', 'job_not_found');
  return Response.json(serializeJob(job));
});
