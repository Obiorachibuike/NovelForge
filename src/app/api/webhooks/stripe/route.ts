import { processWebhook } from '@/services/billing/service';
import { apiHandler, HttpError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

/**
 * Stripe webhook endpoint.
 *
 * The raw body is required for signature verification, so it is read as text and
 * never parsed before `processWebhook` has validated it. Both `POST` and `PUT`
 * are accepted because Stripe retries with the same method.
 */
async function handle(req: Request): Promise<Response> {
  const raw = await req.text();
  if (raw.length > 512 * 1024) throw new HttpError(413, 'Webhook payload too large.', 'payload_too_large');
  const signature = req.headers.get('stripe-signature');
  const outcome = await processWebhook(raw, signature);
  return Response.json(outcome);
}

export const POST = apiHandler(handle);
export const PUT = apiHandler(handle);
