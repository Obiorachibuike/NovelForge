import { requireUser } from '@/lib/db/ownership';
import { apiHandler, HttpError } from '@/lib/api/http';
import { getGenerationForUser, serializeGeneration } from '@/lib/jobs/generation-jobs';
// Importing the chapter service registers generation handlers in runtimes that
// read a job (e.g. a single-process deployment using the database transport).
import '@/services/chapters/service';
import '@/services/generation/universal-text';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/generations/[jobId] — owner-only generation details. */
export const GET = apiHandler(async (_req: Request, ctx: { params: { jobId: string } }) => {
  const user = await requireUser();
  const job = getGenerationForUser(user.id, ctx.params.jobId);
  if (!job) throw new HttpError(404, 'Generation not found', 'generation_not_found');
  return Response.json(
    { generation: serializeGeneration(job, { includeContent: true }) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
