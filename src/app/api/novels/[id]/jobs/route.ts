import { requireUser, requireNovel } from '@/lib/db/ownership';
import { listJobs, serializeJob } from '@/lib/queue';
import { apiHandler } from '@/lib/api/http';

/** Protected, ownership-checked view of every generation job for one novel. */
export const GET = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  const limit = Math.min(100, Math.max(1, Number(new URL(req.url).searchParams.get('limit') || 20)));
  return Response.json((await listJobs(ctx.params.id, { limit })).map(serializeJob));
});
