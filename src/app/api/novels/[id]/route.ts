import { requireUser, requireNovel } from '@/lib/db/ownership';
import { getNovel, deleteNovel } from '@/services/novels/service';
import { apiHandler, HttpError } from '@/lib/api/http';

export const GET = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  const novel = await getNovel(ctx.params.id, user.id);
  if (!novel) throw new HttpError(404, 'Novel not found', 'novel_not_found');
  return Response.json(novel);
});

export const DELETE = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  await deleteNovel(ctx.params.id, user.id);
  return Response.json({ ok: true });
});
