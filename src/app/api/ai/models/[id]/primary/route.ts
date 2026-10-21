import { requireUser } from '@/lib/db/ownership';
import { apiHandler, HttpError } from '@/lib/api/http';
import { requireAdmin } from '@/services/billing/service';
import { getModelRow, setPrimaryModel, syncRegistry } from '@/lib/ai/model-registry';

export const dynamic = 'force-dynamic';

/**
 * Administrator-only: makes a model the preferred (primary) model for its task.
 *
 * Primacy is a scoring bonus in the selection engine, not a hard pin: if the
 * primary model is unavailable, ineligible under the pricing policy, or its
 * circuit breaker is open, another eligible model is used instead.
 */
export const POST = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  requireAdmin(user.id);
  const id = decodeURIComponent(ctx.params.id);
  syncRegistry();
  const model = getModelRow(id);
  if (!model) throw new HttpError(404, `Model "${id}" is not registered.`, 'model_not_found');
  setPrimaryModel(model.task, id);
  return Response.json({ model: getModelRow(id) });
});

export const DELETE = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  requireAdmin(user.id);
  const id = decodeURIComponent(ctx.params.id);
  syncRegistry();
  const model = getModelRow(id);
  if (!model) throw new HttpError(404, `Model "${id}" is not registered.`, 'model_not_found');
  if (model.isPrimary) setPrimaryModel(model.task, null);
  return Response.json({ model: getModelRow(id) });
});
