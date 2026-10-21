import { requireUser, requireNovel } from '@/lib/db/ownership';
import { generateCovers, listCovers } from '@/services/images/service';
import { setCover } from '@/services/novels/service';
import { coverGenerateSchema, coverSelectSchema } from '@/types';
import { apiHandler, readJsonBody } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { assertRegisteredModel } from '@/lib/ai/model-selection';

export const GET = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  return Response.json(await listCovers(ctx.params.id));
});

export const POST = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  enforceRateLimit('aiImage', user.id);
  enforceAiRateLimit('image', user.id);
  const body = await readJsonBody(req, v => coverGenerateSchema.parse(v));
  // Rejects any id that is not in the registry: the endpoint must never proxy
  // an arbitrary Hugging Face repository.
  const imageModel = assertRegisteredModel(body.imageModel, 'text-to-image');
  const covers = await generateCovers(user.id, ctx.params.id, body.prompt, body.variants, {
    ...(imageModel !== 'auto' ? { imageModel } : {}),
    allowFallback: body.allowFallback,
  });
  return Response.json(covers);
});

export const PUT = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  const { imageId } = await readJsonBody(req, v => coverSelectSchema.parse(v));
  const result = await setCover(ctx.params.id, user.id, imageId);
  return Response.json(result);
});
