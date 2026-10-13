import { requireUser, requireNovel } from '@/lib/db/ownership';
import { getSettings, updateNovelSettings } from '@/services/novels/service';
import { novelSettingsSchema } from '@/types';
import { apiHandler, readJsonBody } from '@/lib/api/http';

export const GET = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  return Response.json(getSettings(ctx.params.id));
});

/**
 * Persists manuscript + export formatting settings. These values drive the
 * export layout, so they must survive restarts (and previously did not: the
 * UPDATE never matched a row because of a parameter-binding bug).
 */
export const PUT = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  const patch = await readJsonBody(req, v => novelSettingsSchema.partial().parse(v));
  return Response.json(await updateNovelSettings(ctx.params.id, user.id, patch));
});
