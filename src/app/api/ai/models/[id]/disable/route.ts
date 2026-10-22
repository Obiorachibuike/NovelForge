import { requireUser } from '@/lib/db/ownership';
import { apiHandler, HttpError, readJsonBody } from '@/lib/api/http';
import { requireAdmin } from '@/services/billing/service';
import { getModelRow, recordModelEvent, setModelEnabled, syncRegistry } from '@/lib/ai/model-registry';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  reason: z.string().max(300).optional(),
});

/**
 * Administrator-only: disables a model.
 *
 * Disabling is a policy decision, not a delete: the row and its verification
 * history are kept so a model can be re-enabled without losing evidence.
 */
export const POST = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  requireAdmin(user.id);
  const id = decodeURIComponent(ctx.params.id);
  syncRegistry();
  if (!getModelRow(id)) throw new HttpError(404, `Model "${id}" is not registered.`, 'model_not_found');
  const body = await readJsonBody(req, v => bodySchema.parse(v ?? {}));
  const model = setModelEnabled(id, false, body.reason ?? 'Disabled by an administrator.');
  recordModelEvent({
    modelId: id,
    kind: 'admin',
    ok: true,
    message: `Disabled by ${user.id}${body.reason ? `: ${body.reason}` : ''}`,
  });
  return Response.json({ model });
});
