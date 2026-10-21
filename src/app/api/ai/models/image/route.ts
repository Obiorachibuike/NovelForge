import { requireUser } from '@/lib/db/ownership';
import { apiHandler } from '@/lib/api/http';
import { aiPolicy } from '@/lib/ai/config';
import { getPrimaryModel, listModelRows, syncRegistry } from '@/lib/ai/model-registry';

export const dynamic = 'force-dynamic';

/** Text-to-image models (for the cover studio's model selector). */
export const GET = apiHandler(async (_req: Request) => {
  const user = await requireUser();
  syncRegistry();
  const models = listModelRows({ task: 'text-to-image', limit: 200 });
  const policy = aiPolicy();
  return Response.json({
    models,
    count: models.length,
    primary: getPrimaryModel('text-to-image')?.id ?? null,
    policy: {
      allowPaidInference: policy.allowPaidInference,
      requireConfirmedPricing: policy.requireConfirmedPricing,
      fallbackEnabled: policy.fallbackEnabled,
      maxImageEdge: policy.maxImageEdge,
    },
    viewer: { userId: user.id },
  });
});
