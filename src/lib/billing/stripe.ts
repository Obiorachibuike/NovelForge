import Stripe from 'stripe';
import 'server-only';

/**
 * Stripe client.
 *
 * Billing is optional: when `STRIPE_SECRET_KEY` is absent the app runs with
 * novel creation gated by entitlements only (admins/comps/subscriptions recorded
 * in the database) and every billing endpoint answers 503
 * `billing_not_configured` instead of pretending a payment can be taken.
 */
let _client: Stripe | null = null;
let _clientKey: string | null = null;

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

export function webhookConfigured(): boolean {
  return stripeConfigured() && !!process.env.STRIPE_WEBHOOK_SECRET;
}

export function webhookSecret(): string | null {
  const value = process.env.STRIPE_WEBHOOK_SECRET;
  return value && value.trim() ? value.trim() : null;
}

/** Host overrides exist so tests can point the SDK at a local Stripe-shaped server. */
export function getStripe(): Stripe | null {
  if (!stripeConfigured()) return null;
  const key = process.env.STRIPE_SECRET_KEY!;
  if (_client && _clientKey === key) return _client;

  // No pinned apiVersion: the SDK uses the version it was released against.
  const options: Stripe.StripeConfig = { appInfo: { name: 'NovelForge' } };
  if (process.env.STRIPE_API_HOST) {
    options.host = process.env.STRIPE_API_HOST;
    options.protocol = (process.env.STRIPE_API_PROTOCOL as 'http' | 'https') || 'http';
    if (process.env.STRIPE_API_PORT) options.port = Number(process.env.STRIPE_API_PORT);
  }
  _client = new Stripe(key, options);
  _clientKey = key;
  return _client;
}

/** Test seam: drops the memoised client so env changes take effect. */
export function resetStripeForTests() {
  _client = null;
  _clientKey = null;
}

/**
 * Verifies a webhook signature with Stripe's own implementation.
 *
 * Never parse an unverified payload: `constructEvent` is the only place a
 * webhook body is trusted, and it throws on a bad signature, a wrong secret or
 * a timestamp outside the tolerance window.
 */
export function parseWebhookEvent(rawBody: string, signature: string | null): Stripe.Event {
  const secret = webhookSecret();
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  if (!signature) throw new Error('Missing stripe-signature header');
  return Stripe.webhooks.constructEvent(rawBody, signature, secret);
}

export default getStripe;
