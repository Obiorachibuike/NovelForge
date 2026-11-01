import 'server-only';

import {
  apiHandler,
  readJsonBody,
  HttpError,
} from '@/lib/api/http';

import {
  requireUser,
  requireNovel,
} from '@/lib/db/ownership';

import {
  UniversalGenerationService,
} from '@/lib/ai/generation/generation-service';

import {
  GenerationRequestSchema,
} from '@/lib/ai/generation/generation-types';

import {
  getGenerationForUser,
  serializeGeneration,
} from '@/lib/jobs/generation-jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/generations/universal
 *
 * Migration Bridge:
 * Routes existing AI generation workflows through
 * UniversalGenerationService.
 */
export const POST = apiHandler(async (req: Request) => {
  // 1. Authenticate user
  const user = await requireUser();

  // 2. Validate incoming request
  const body = await readJsonBody(req, (value) =>
    GenerationRequestSchema.parse(value)
  );

  // 3. Validate project ownership when projectId exists
  if (body.projectId) {
    await requireNovel(body.projectId, user.id);
  }

  // 4. Validate required projectId before job creation
  if (!body.projectId) {
    throw new HttpError(
      400,
      'A valid projectId is required for this generation request.',
      'project_id_required'
    );
  }

  // 5. Create generation job
  const jobId = await UniversalGenerationService.createJob({
    ...body,
    projectId: body.projectId,
    userId: user.id,
  });

  // 6. Retrieve the newly created job
  const job = getGenerationForUser(user.id, jobId);

  if (!job) {
    throw new HttpError(
      500,
      'Generation job was created but could not be retrieved.',
      'generation_missing'
    );
  }

  // 7. Return job information
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
    {
      status: 202,
    }
  );
});
