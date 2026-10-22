import { requireUser } from '@/lib/db/ownership';
import { apiHandler } from '@/lib/api/http';
import { aiPolicy } from '@/lib/ai/config';
import { listModelRows, syncRegistry, registryOverview } from '@/lib/ai/model-registry';
import type { ModelAvailability, ModelPricing, ModelTask } from '@/lib/ai/types';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  task: z.enum(['text-generation', 'text-to-image']).optional(),
  category: z.string().max(120).optional(),
  search: z.string().max(120).optional(),
  availability: z.string().max(400).optional(),
  pricing: z.string().max(200).optional(),
  enabled: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  overview: z.enum(['true', 'false']).optional(),
});

const AVAILABILITY_VALUES: ModelAvailability[] = [
  'unverified', 'available', 'unavailable', 'unsupported',
  'authentication_required', 'rate_limited', 'temporarily_unavailable', 'paid_only', 'unknown',
];
const PRICING_VALUES: ModelPricing[] = ['free', 'paid', 'unknown'];

/**
 * Model catalogue.
 *
 * Any authenticated user may read it (model selection in the writing UI needs
 * availability and pricing), but the payload never contains credentials, and
 * mutations are admin-only.
 */
export const GET = apiHandler(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.errors[0]?.message ?? 'Invalid query', code: 'validation_failed' }, { status: 400 });
  }
  const query = parsed.data;
  syncRegistry();

  const availability = query.availability
    ? (query.availability.split(',').filter(v => AVAILABILITY_VALUES.includes(v as ModelAvailability)) as ModelAvailability[])
    : undefined;
  const pricing = query.pricing
    ? (query.pricing.split(',').filter(v => PRICING_VALUES.includes(v as ModelPricing)) as ModelPricing[])
    : undefined;

  const models = listModelRows({
    ...(query.task ? { task: query.task as ModelTask } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.search ? { search: query.search } : {}),
    ...(availability?.length ? { availability } : {}),
    ...(pricing?.length ? { pricing } : {}),
    ...(query.enabled ? { enabled: query.enabled === 'true' } : {}),
    limit: query.limit ?? 200,
  });

  const policy = aiPolicy();
  return Response.json({
    models,
    count: models.length,
    ...(query.overview === 'true' ? { overview: registryOverview() } : {}),
    policy: {
      backend: policy.backend,
      allowPaidInference: policy.allowPaidInference,
      requireConfirmedPricing: policy.requireConfirmedPricing,
      fallbackEnabled: policy.fallbackEnabled,
      maxFallbackAttempts: policy.maxFallbackAttempts,
    },
    viewer: { userId: user.id },
  });
});
