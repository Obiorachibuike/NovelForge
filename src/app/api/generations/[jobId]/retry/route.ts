import { requireUser } from '@/lib/db/ownership';
import { apiHandler } from '@/lib/api/http';
import { retryGeneration } from '@/lib/jobs/generation-jobs';
import { enforceRateLimit } from '@/lib/security/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/generations/[jobId]/retry
 *
 * Only failed or cancelled generations can be retried. The retry reuses the
 * same row and is idempotent with the worker's own duplicate-prevention checks.
 */
export const POST = apiHandler(async (_req: Request, ctx: { params: { jobId: string } }) => {
  const user = await requireUser();
  enforceRateLimit('aiGeneration', user.id);
  const generation = await retryGeneration(user.id, ctx.params.jobId);
  return Response.json({ ok: true, generation });
});
