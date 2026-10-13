import { requireUser, requireNovel } from '@/lib/db/ownership';
import { updateOutline, listOutlines } from '@/services/outlines/service';
import { outlinePatchSchema } from '@/types';
import { apiHandler, readJsonBody } from '@/lib/api/http';

/** Author edits to a planned chapter (title, summary, targets). */
export const PATCH = apiHandler(async (req: Request, ctx: { params: { id: string; outlineId: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  const patch = await readJsonBody(req, v => outlinePatchSchema.parse(v));
  await updateOutline(ctx.params.outlineId, ctx.params.id, user.id, patch);
  return Response.json({ ok: true, chapters: listOutlines(ctx.params.id) });
});
