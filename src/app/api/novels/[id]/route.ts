import { requireUser, requireNovel } from '@/lib/db/ownership';
import { getNovel, deleteNovel, updateNovel } from '@/services/novels/service';
import { updateNovelSchema } from '@/types';
import { apiHandler, HttpError, readJsonBody } from '@/lib/api/http';

export const GET = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  const novel = await getNovel(ctx.params.id, user.id);
  if (!novel) throw new HttpError(404, 'Novel not found', 'novel_not_found');
  return Response.json(novel);
});

export const PATCH = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  const patch = await readJsonBody(req, v => updateNovelSchema.parse(v));
  const updated = await updateNovel(ctx.params.id, user.id, patch);
  return Response.json(updated);
});

export const DELETE = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  await deleteNovel(ctx.params.id, user.id);
  return Response.json({ ok: true });
});
