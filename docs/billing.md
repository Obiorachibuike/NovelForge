# Billing and administrator privileges

NovelForge has **no free tier**: creating a novel requires an *entitlement*, which comes from exactly
three places.

| Source | How it is granted | Entitlement reason |
| --- | --- | --- |
| Administrator role | `ADMIN_EMAILS`, `npm run admin:grant -- <email>`, or the `/admin` console | `admin` |
| Free-access comp | An administrator toggles **Grant free access** on an account in `/admin` | `comp` |
| Active subscription | Stripe Checkout for the Author or Studio plan | `subscription` |

Everything else is refused with HTTP **402 `payment_required`**, both in `POST /api/novels` and inside
`createNovel()` — the service checks, so no caller can bypass the route. The response carries the reason
and a `pricingUrl` pointer:

```json
{
  "error": "An active plan is required to create a novel. Choose a plan to continue.",
  "code": "payment_required",
  "reason": "subscription_required",
  "plan": null,
  "novelLimit": 0,
  "novelsInProgress": 0,
  "pricingUrl": "/pricing"
}
```

`reason` is one of `subscription_required`, `subscription_inactive`, `novel_limit_reached` (or omitted on
success). "Novels in progress" means every novel whose `status` is not `completed`, so finishing a novel
frees a slot.

## Plans

Defined in `src/lib/billing/plans.ts` (display metadata only — the Stripe price ids come from the
environment so the same build can point at test or live Stripe):

| Plan | Price | Novels in progress | Price id env var |
| --- | --- | --- | --- |
| Author | $12 / month | 3 | `STRIPE_PRICE_AUTHOR` |
| Studio | $29 / month | 12 | `STRIPE_PRICE_STUDIO` |

The numbers above must match the products you create in Stripe. A plan whose price id is not configured
cannot be bought: `POST /api/billing/checkout` answers **503 `billing_not_configured`** naming the missing
variable, the button says so instead of failing at the payment page, and `/pricing` shows a banner that
billing is not connected on this deployment.

## Environment variables

```bash
STRIPE_SECRET_KEY=sk_live_…        # required for any Stripe call
STRIPE_WEBHOOK_SECRET=whsec_…      # required to verify webhook deliveries
STRIPE_PRICE_AUTHOR=price_…        # /pricing → Author
STRIPE_PRICE_STUDIO=price_…        # /pricing → Studio
ADMIN_EMAILS=you@example.com       # bootstrap administrators (comma separated)
NEXT_PUBLIC_APP_URL=https://your-app.example.com  # success/cancel/return URLs
```

Nothing here is required for the rest of the product to run. With no `STRIPE_SECRET_KEY`:
entitlements (admins + comps) still work, `/pricing` renders, and every billing endpoint answers 503 —
never a fabricated success.

## Stripe setup

1. **Products.** In the Stripe dashboard create two recurring monthly prices — Author $12, Studio $29 —
   and copy the `price_…` ids into `STRIPE_PRICE_AUTHOR` / `STRIPE_PRICE_STUDIO`.
2. **Webhook endpoint.** Add `https://<your-domain>/api/webhooks/stripe` and subscribe to:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. Locally:
   `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.
3. **Billing portal.** Enable the customer portal in the dashboard (Settings → Billing → Customer portal)
   so **Manage subscription** on `/settings` has somewhere to go. Stripe hosts both Checkout and the
   portal, so no card data ever reaches NovelForge.
4. **First administrator.** Either set `ADMIN_EMAILS` to your address (the account is promoted the next
   time anything resolves its entitlement, and the promotion is written to `users.role`) or run
   `npm run admin:grant -- you@example.com` after the account has registered. Demote with
   `npm run admin:grant -- you@example.com --revoke`.

## How a purchase flows

1. `/pricing` → **Choose Author/Studio** → `POST /api/billing/checkout { plan }`.
   The plan must be a catalogue id; the Stripe price, the customer and the metadata all come from the
   server, and the browser is redirected to the Stripe-hosted Checkout URL.
2. Stripe sends `checkout.session.completed`. NovelForge verifies the signature with
   `STRIPE_WEBHOOK_SECRET`, then **re-fetches the subscription from the API** rather than trusting the
   thinner session payload, and projects it into `subscriptions`.
3. The plan is resolved from *our* configured price id only. An unrecognised price is stored as
   `unknown` and grants nothing; `metadata.plan` on an event is never trusted.
4. `customer.subscription.updated` / `deleted` and `invoice.payment_failed` keep the local row in step.
   Only `active` and `trialing` entitle; `past_due`, `unpaid`, `incomplete`, `incomplete_expired` and
   `canceled` do not. A `deleted` event is forced to `canceled` even if the payload still says `active`.
5. `POST /api/billing/portal` opens the Stripe Billing Portal for the customer already attached to the
   account (409 `no_billing_account` before the first checkout, so a fresh account is pointed at
   `/pricing` instead of an empty portal).

**Idempotency.** Every processed event id is inserted into `stripe_events` with a primary key, using
`ON CONFLICT DO NOTHING`. A redelivery returns `{ "received": true, "duplicate": true }` and changes
nothing — the plan can never be granted twice from one event.

## Administration

`/admin` (administrators only — the page redirects non-admins, and every admin route re-checks with
`requireAdmin`, answering 403 `admin_only`) lists accounts with their plan, novels in progress, whether
they can currently create a novel and why, plus buttons to:

- **Grant / Revoke free access** — sets `users.freeNovelAccess` (+ `freeNovelGrantedBy`/`At`), so an
  account can create novels free without a subscription.
- **Make admin / Remove admin** — changes `users.role`.

Guard rails: an administrator cannot change their own role (409 `cannot_modify_self`) and the last
remaining administrator cannot be demoted (409 `last_admin`; note that with the self-demotion guard in
place the admin count can never reach zero, so this is defence in depth). Every change is written to
`admin_audit_log` (`role_changed`, `free_access_granted`, `free_access_revoked`, plus the CLI's
`role_granted_cli` / `role_revoked_cli`) with the actor, the target and the timestamp, and the last 25
entries are shown at the bottom of the console. Entitlement lookups **never** return password material.

`ADMIN_EMAILS` promotion is deliberately sticky: removing an address from the list does not silently
strip rights from a live account — that is an explicit, audited demotion.

## Files

| Path | Role |
| --- | --- |
| `src/lib/billing/plans.ts` | Plan catalogue, price-id lookup, `planForPriceId` |
| `src/lib/billing/stripe.ts` | Lazily created Stripe client, `parseWebhookEvent`, test seams |
| `src/services/billing/service.ts` | Entitlements, `assertCanCreateNovel`, checkout/portal, webhook projection, admin operations |
| `src/app/api/billing/{checkout,portal}/route.ts` | Authenticated billing endpoints |
| `src/app/api/webhooks/stripe/route.ts` | Signature-verified webhook (`POST`/`PUT`, raw body) |
| `src/app/api/admin/users/route.ts`, `…/[userId]/route.ts` | Admin directory + privilege changes |
| `src/app/pricing/page.tsx`, `src/components/billing/*` | Pricing page, plan cards, settings billing panel |
| `src/app/admin/page.tsx`, `src/components/admin/AdminUsers.tsx` | Admin console |
| `src/app/novels/new/page.tsx` | Shows the plan prompt instead of a form that would 402 |
| `scripts/grant-admin.ts` | `npm run admin:grant -- <email> [--revoke]` |
| `migration 0005_billing_and_roles` | `users.role` / free-access columns, `subscriptions`, `stripe_events`, `admin_audit_log` |

## Tests

`tests/security/billing.test.ts` (25) and `tests/security/billing-routes.test.ts` (11) run against a
local `node:http` server that speaks the Stripe shapes the SDK needs (customers, checkout sessions,
billing portal, subscription retrieval) and Stripe's own `webhooks.generateTestHeaderString` for
signatures — no network, no live keys. They cover: the 402 gate, plan limits, completed novels freeing a
slot, comps, the admin role, grant/revoke with audit rows, self-demotion and last-admin guards, admin
listing without password material, checkout/portal calls (and their 503/409 refusals), bad signatures,
replay idempotency, subscription lifecycle (cancel / past_due / restore), unknown price ids, and metadata
that tries to upgrade a plan.

## Not verified here

The sandbox these changes were built in has **no Stripe account and no internet access to Stripe**, so
no live Checkout, Portal or webhook delivery was executed. Everything above was exercised against the
local fake Stripe server and Stripe's signature helper. Before going live, run one real test-mode
purchase end-to-end (`stripe listen` + a `4242 4242 4242 4242` card) and confirm the plan appears on
`/settings` and `/admin`.
