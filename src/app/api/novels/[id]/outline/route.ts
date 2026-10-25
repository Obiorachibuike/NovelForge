import { requireUser, requireNovel } from '@/lib/db/ownership';
import { enqueueOutline, listOutlines, listActs } from '@/services/outlines/service';
import { outlineSchema } from '@/types';
import { apiHandler, readJsonBody } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { assertRegisteredModelOrAgnes } from '@/lib/ai/model-selection';

export const GET = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  return Response.json({ acts: listActs(ctx.params.id), chapters: listOutlines(ctx.params.id) });
});

export const POST = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  enforceRateLimit('aiGeneration', user.id);
  enforceAiRateLimit('text', user.id);
  const body = await readJsonBody(req, v => outlineSchema.parse(v));
  const textModel = assertRegisteredModelOrAgnes(body.textModel, 'text-generation');
  return Response.json({
    jobId: await enqueueOutline(user.id, ctx.params.id, body.structure, {
      ...(textModel !== 'auto' ? { textModel } : {}),
      allowFallback: body.allowFallback,
    }),
  });
});
