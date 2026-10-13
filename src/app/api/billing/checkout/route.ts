import { requireUser } from '@/lib/db/ownership';
import { createCheckoutSession } from '@/services/billing/service';
import { checkoutSchema } from '@/types';
import { apiHandler, readJsonBody } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';

/**
 * Starts a Stripe Checkout session for a plan.
 *
 * The plan must be one of our catalogue entries (the request cannot name an
 * arbitrary Stripe price), and the customer is derived from the session, never
 * from the request body.
 */
export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  enforceRateLimit('export', `checkout:${user.id}`);
  const body = await readJsonBody(req, v => checkoutSchema.parse(v));
  return Response.json(await createCheckoutSession(user.id, body.plan));
});
