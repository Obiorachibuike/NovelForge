import 'server-only';
import { apiHandler, readJsonBody, HttpError } from '@/lib/api/http';
import { requireUser, requireNovel } from '@/lib/db/ownership';
import { UniversalGenerationService } from '@/lib/ai/generation/generation-service';
import { validateGenerationInput } from '@/lib/ai/generation/generation-validation';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { getGenerationForUser, serializeGeneration } from '@/lib/jobs/generation-jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/generations/universal (Migration Bridge)
 *
 * Bridges existing endpoints (text, humanize, outline, premise, chapter)
 * to the UniversalGenerationService.
 */
export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  enforceRateLimit('aiGeneration', user.id);
  enforceAiRateLimit('text', user.id);
  const body = await readJsonBody(req, v => validateGenerationInput(v, user.id));

  // Project ownership check
  await requireNovel(body.projectId, user.id);

  // Create Universal Job
  const jobId = await UniversalGenerationService.createJob(body);

  const job = getGenerationForUser(user.id, jobId);
  if (!job) throw new HttpError(500, 'Job creation failed', 'generation_missing');

  return Response.json(
    {
      ok: true,
      jobId,
      generation: serializeGeneration(job),
      statusUrl: `/api/generations/${jobId}`,
      eventsUrl: `/api/generations/${jobId}/events`,
      cancelUrl: `/api/generations/${jobId}/cancel`,
      retryUrl: `/api/generations/${jobId}/retry`,
    },
    { status: 202 }
  );
});
