import { requireUser } from '@/lib/db/ownership';
import { apiHandler } from '@/lib/api/http';
import { cancelGeneration } from '@/lib/jobs/generation-jobs';
import { enforceRateLimit } from '@/lib/security/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/generations/[jobId]/cancel
 *
 * Ownership is checked by `cancelGeneration`. Cancellation is cooperative:
 * the worker observes the durable status, aborts the provider request where
 * supported, and never overwrites existing chapter content. Completed jobs are
 * rejected with 409.
 */
export const POST = apiHandler(async (_req: Request, ctx: { params: { jobId: string } }) => {
  const user = await requireUser();
  enforceRateLimit('generationControl', user.id);
  const generation = await cancelGeneration(user.id, ctx.params.jobId);
  return Response.json({ ok: true, generation });
});
