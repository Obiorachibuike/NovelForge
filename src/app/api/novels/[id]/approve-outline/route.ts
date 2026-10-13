import { requireUser, requireNovel } from '@/lib/db/ownership';
import { approveOutline } from '@/services/outlines/service';
import { apiHandler } from '@/lib/api/http';

export const POST = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  await approveOutline(user.id, ctx.params.id);
  return Response.json({ ok: true });
});
