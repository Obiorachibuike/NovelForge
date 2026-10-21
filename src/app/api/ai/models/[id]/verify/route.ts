import { requireUser } from '@/lib/db/ownership';
import { apiHandler, HttpError, readJsonBody } from '@/lib/api/http';
import { requireAdmin } from '@/services/billing/service';
import { getModelRow, recordModelEvent, syncRegistry } from '@/lib/ai/model-registry';
import { verifyModel } from '@/lib/ai/model-verification';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  /** Run a real, minimal inference (text only unless live image checks are enabled). */
  smoke: z.boolean().default(false),
  force: z.boolean().default(true),
});

/**
 * Manual, administrator-only verification of one model.
 *
 * Cheap by default (repository + provider-mapping checks). A live smoke test is
 * opt-in because it spends provider quota, and image smoke tests additionally
 * require `AI_ALLOW_LIVE_IMAGE_HEALTH_CHECKS=true`.
 */
export const POST = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  requireAdmin(user.id);

  const id = decodeURIComponent(ctx.params.id);
  syncRegistry();
  if (!getModelRow(id)) throw new HttpError(404, `Model "${id}" is not registered.`, 'model_not_found');

  const body = await readJsonBody(req, v => bodySchema.parse(v ?? {}));
  const report = await verifyModel(id, { smoke: body.smoke, force: body.force });
  recordModelEvent({
    modelId: id,
    kind: 'admin',
    ok: report.availability === 'available',
    message: `Manual verification by ${user.id} (smoke: ${body.smoke ? 'yes' : 'no'})`,
  });
  return Response.json(report);
});
