import { requireUser } from '@/lib/db/ownership';
import { apiHandler, HttpError, readJsonBody } from '@/lib/api/http';
import { requireAdmin } from '@/services/billing/service';
import { getModelRow, setModelEnabled, syncRegistry } from '@/lib/ai/model-registry';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  reason: z.string().max(300).optional(),
});

/** Administrator-only: re-enables a model for automatic selection. */
export const POST = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  requireAdmin(user.id);
  const id = decodeURIComponent(ctx.params.id);
  syncRegistry();
  if (!getModelRow(id)) throw new HttpError(404, `Model "${id}" is not registered.`, 'model_not_found');
  await readJsonBody(req, v => bodySchema.parse(v ?? {}));
  const model = setModelEnabled(id, true);
  return Response.json({ model });
});
