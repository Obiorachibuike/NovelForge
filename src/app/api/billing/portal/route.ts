import { requireUser } from '@/lib/db/ownership';
import { createPortalSession } from '@/services/billing/service';
import { apiHandler } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';

/** Opens the Stripe Billing Portal for the customer attached to this account. */
export const POST = apiHandler(async (_req: Request) => {
  const user = await requireUser();
  enforceRateLimit('export', `portal:${user.id}`);
  return Response.json(await createPortalSession(user.id));
});
