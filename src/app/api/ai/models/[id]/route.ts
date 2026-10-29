import { requireUser } from '@/lib/db/ownership';
import { apiHandler, HttpError } from '@/lib/api/http';
import { deleteModel, getModelRow, recentModelEvents, syncRegistry } from '@/lib/ai/model-registry';
import { requireAdmin } from '@/services/billing/service';

export const dynamic = 'force-dynamic';

/** Full detail for one model: registry row plus its recent event history. */
export const GET = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  const id = decodeURIComponent(ctx.params.id);
  syncRegistry();
  const model = getModelRow(id);
  if (!model) throw new HttpError(404, `Model "${id}" is not registered.`, 'model_not_found');
  const events = recentModelEvents({ modelId: id, limit: 20 });
  void user;
  return Response.json({
    model,
    events,
    limitations: model.limitations ? safeParse(model.limitations) : [],
    adapter: model.adapter ? safeParse(model.adapter) : null,
    supportedSizes: model.supportedSizes ? safeParse(model.supportedSizes) : [],
  });
});

/** Administrator-only: deletes a custom or registry model. */
export const DELETE = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  requireAdmin(user.id);
  const id = decodeURIComponent(ctx.params.id);
  syncRegistry();
  const model = getModelRow(id);
  if (!model) throw new HttpError(404, `Model "${id}" is not registered.`, 'model_not_found');
  const ok = deleteModel(id);
  if (!ok) throw new HttpError(500, 'Could not delete model.', 'delete_failed');
  return Response.json({ ok: true, deletedId: id });
});

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
