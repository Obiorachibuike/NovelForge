import { requireUser, requireNovel } from '@/lib/db/ownership';
import { approveChapter } from '@/services/chapters/service';
import { apiHandler } from '@/lib/api/http';

export const POST = apiHandler(async (_req: Request, ctx: { params: { id: string; chapterId: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  await approveChapter(user.id, ctx.params.id, ctx.params.chapterId);
  return Response.json({ ok: true });
});
