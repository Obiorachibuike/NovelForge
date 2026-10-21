import { requireUser } from '@/lib/db/ownership';
import { apiHandler } from '@/lib/api/http';
import { requireAdmin } from '@/services/billing/service';
import { adminUsageSummary } from '@/lib/ai/usage-tracker';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ windowHours: z.coerce.number().int().min(1).max(720).optional() });

/**
 * Aggregated AI usage for administrators.
 *
 * Costs are reported with their status: `confirmed` (provider reported),
 * `estimated` (computed from published prices) or `unknown` (never shown as 0).
 * No per-user story content is included.
 */
export const GET = apiHandler(async (req: Request) => {
  const user = await requireUser();
  requireAdmin(user.id);
  const url = new URL(req.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  const windowHours = parsed.success ? (parsed.data.windowHours ?? 24) : 24;
  return Response.json(adminUsageSummary(windowHours));
});
