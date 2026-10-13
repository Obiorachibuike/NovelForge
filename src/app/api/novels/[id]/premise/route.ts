import { requireUser, requireNovel } from '@/lib/db/ownership';
import { getPremise, updatePremiseField } from '@/services/preparation/service';
import { premisePatchSchema } from '@/types';
import { apiHandler, readJsonBody } from '@/lib/api/http';

/**
 * Author edits to the generated preparation material. Generated text is a
 * starting point, not the truth: the author can always override it, and a later
 * regeneration requires an explicit action by the author.
 */
export const GET = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  return Response.json({ premise: await getPremise(ctx.params.id) });
});

export const PATCH = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  const patch = await readJsonBody(req, v => premisePatchSchema.parse(v));
  return Response.json({ premise: await updatePremiseField(ctx.params.id, user.id, patch) });
});
