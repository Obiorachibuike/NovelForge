import { requireUser } from '@/lib/db/ownership';
import { apiHandler } from '@/lib/api/http';
import { requireAdmin } from '@/services/billing/service';
import { recentModelEvents } from '@/lib/ai/model-registry';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  modelId: z.string().max(200).optional(),
});

/**
 * Recent model failures, most recent first.
 *
 * Messages are the classifier's user-safe text: no tokens, no raw provider
 * bodies, no account identifiers.
 */
export const GET = apiHandler(async (req: Request) => {
  const user = await requireUser();
  requireAdmin(user.id);
  const url = new URL(req.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;
  const modelId = parsed.success ? parsed.data.modelId : undefined;
  return Response.json({
    failures: recentModelEvents({ limit, onlyFailures: true, ...(modelId ? { modelId } : {}) }),
  });
});
