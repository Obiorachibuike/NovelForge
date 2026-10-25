import { requireUser, requireNovel } from '@/lib/db/ownership';
import { enqueuePrepareNovel, getPremise } from '@/services/preparation/service';
import { apiHandler, readJsonBody } from '@/lib/api/http';
import { prepareSchema } from '@/types';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { assertRegisteredModelOrAgnes } from '@/lib/ai/model-selection';

export const GET = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  return Response.json({ premise: await getPremise(ctx.params.id) });
});

export const POST = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  enforceRateLimit('aiGeneration', user.id);
  enforceAiRateLimit('text', user.id);
  const body = await readJsonBody(req, v => prepareSchema.parse(v));
  const textModel = assertRegisteredModelOrAgnes(body.textModel, 'text-generation');
  return Response.json({
    jobId: await enqueuePrepareNovel(user.id, ctx.params.id, {
      ...(textModel !== 'auto' ? { textModel } : {}),
      allowFallback: body.allowFallback,
    }),
  });
});
