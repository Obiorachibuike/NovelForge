/**
 * Billing, entitlements and the admin console.
 *
 * Stripe is exercised through a local HTTP server that speaks the shapes the SDK
 * expects (checkout sessions, billing portal, subscription retrieval) plus
 * Stripe's own signature helper for webhooks — no network access, no live keys.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import Stripe from 'stripe';
import { getDb, closeDb } from '@/lib/db';
import { resetStripeForTests } from '@/lib/billing/stripe';
import {
  assertCanCreateNovel, resolveEntitlement, createCheckoutSession, createPortalSession,
  processWebhook, upsertSubscription, requireAdmin, isAdmin, updateUserPrivileges,
  listUsersForAdmin, listAuditLog, countAdmins,
} from '@/services/billing/service';
import { createNovel } from '@/services/novels/service';
import { HttpError } from '@/lib/api/http';

const WEBHOOK_SECRET = 'whsec_test_secret';
const AUTHOR_PRICE = 'price_author_test';
const STUDIO_PRICE = 'price_studio_test';

interface Recorded {
  method: string;
  path: string;
  body: Record<string, any>;
}

/** Minimal Stripe-shaped server: records requests, answers with fixtures. */
function startFakeStripe() {
  const requests: Recorded[] = [];
  let nextSubscription: Record<string, any> | null = null;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = Object.fromEntries(new URLSearchParams(raw)) as Record<string, any>;
      const path = (req.url || '').split('?')[0];
      requests.push({ method: req.method || 'GET', path, body });

      const json = (payload: any, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'POST' && path === '/v1/customers') {
        return json({ id: 'cus_test_new', object: 'customer', email: body.email, metadata: body.metadata || {} });
      }
      if (req.method === 'POST' && path === '/v1/checkout/sessions') {
        return json({
          id: 'cs_test_123',
          object: 'checkout.session',
          url: 'https://checkout.stripe.test/cs_test_123',
          mode: body.mode,
          customer: 'cus_test_1',
          client_reference_id: body.client_reference_id,
          metadata: body.metadata || {},
        });
      }
      if (req.method === 'POST' && path === '/v1/billing_portal/sessions') {
        return json({ id: 'bps_test_1', object: 'billing_portal.session', url: 'https://billing.stripe.test/bps_test_1' });
      }
      if (req.method === 'GET' && path.startsWith('/v1/subscriptions/')) {
        if (!nextSubscription) return json({ error: { message: 'No such subscription', type: 'invalid_request_error' } }, 404);
        return json(nextSubscription);
      }
      return json({ error: { message: `unhandled ${req.method} ${path}`, type: 'invalid_request_error' } }, 404);
    });
  });

  return new Promise<{ server: Server; requests: Recorded[]; setSubscription: (s: Record<string, any> | null) => void; port: number }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        server,
        requests,
        setSubscription: s => { nextSubscription = s; },
        port,
      });
    });
  });
}

function stripeSubscription(overrides: Record<string, any> = {}) {
  return {
    id: 'sub_test_1',
    object: 'subscription',
    customer: 'cus_test_1',
    status: 'active',
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    cancel_at_period_end: false,
    items: { data: [{ id: 'si_1', price: { id: AUTHOR_PRICE } }] },
    metadata: {},
    ...overrides,
  };
}

function signed(raw: string) {
  return Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: WEBHOOK_SECRET });
}

async function deliverWebhook(event: Record<string, any>) {
  const raw = JSON.stringify(event);
  return processWebhook(raw, signed(raw));
}

/** A payload that satisfies the novels table's NOT NULL columns. */
function novelInput(title: string) {
  return {
    title, genre: 'Fantasy', targetWords: 80000, targetPages: 250,
    targetChapters: 30, writingMode: 'chapter',
  } as any;
}

/** Mirrors a completed checkout: the Stripe customer is attached to the account. */
function linkCustomer(userId: string, customerId: string) {
  getDb().prepare('UPDATE users SET stripeCustomerId=?, updatedAt=? WHERE id=?')
    .run(customerId, new Date().toISOString(), userId);
}

function seedUser(id: string, email: string, role: 'user' | 'admin' = 'user') {
  const db = getDb();
  db.prepare(
    `INSERT INTO users (id,name,email,passwordHash,role,createdAt,updatedAt)
     VALUES (?,?,?,'x',?,?,?) ON CONFLICT(id) DO NOTHING`,
  ).run(id, id, email, role, new Date().toISOString(), new Date().toISOString());
  return id;
}

let fake: Awaited<ReturnType<typeof startFakeStripe>>;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  fake = await startFakeStripe();
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_AUTHOR', 'STRIPE_PRICE_STUDIO', 'ADMIN_EMAILS', 'STRIPE_API_HOST', 'STRIPE_API_PORT', 'STRIPE_API_PROTOCOL']) {
    savedEnv[key] = process.env[key];
  }
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_PRICE_AUTHOR = AUTHOR_PRICE;
  process.env.STRIPE_PRICE_STUDIO = STUDIO_PRICE;
  process.env.STRIPE_API_HOST = '127.0.0.1';
  process.env.STRIPE_API_PORT = String(fake.port);
  process.env.STRIPE_API_PROTOCOL = 'http';
  delete process.env.ADMIN_EMAILS;
  resetStripeForTests();
});

afterAll(async () => {
  await new Promise<void>(resolve => fake.server.close(() => resolve()));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetStripeForTests();
  closeDb();
});

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM stripe_events').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM admin_audit_log').run();
  db.prepare('DELETE FROM novels').run();
  db.prepare('DELETE FROM users').run();
  fake.requests.length = 0;
  fake.setSubscription(null);
  process.env.STRIPE_PRICE_AUTHOR = AUTHOR_PRICE;
  process.env.STRIPE_PRICE_STUDIO = STUDIO_PRICE;
  delete process.env.ADMIN_EMAILS;
  resetStripeForTests();
});

describe('entitlements gate novel creation', () => {
  it('a plain account with no subscription cannot create a novel (402 payment_required)', async () => {
    seedUser('u_none', 'none@example.com');
    const entitlement = resolveEntitlement('u_none');
    expect(entitlement.canCreateNovel).toBe(false);
    expect(entitlement.reason).toBe('subscription_required');

    let thrown: any;
    try { assertCanCreateNovel('u_none'); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown.status).toBe(402);
    expect(thrown.code).toBe('payment_required');
    expect(thrown.details).toMatchObject({ reason: 'subscription_required', pricingUrl: '/pricing' });

    // The service — not just the route — refuses, so every caller is covered.
    await expect(createNovel('u_none', novelInput('Blocked'))).rejects.toThrowError(/active plan is required/i);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM novels').get()).toMatchObject({ c: 0 });
  });

  it('an active subscription allows creation up to the plan limit', async () => {
    seedUser('u_author', 'author@example.com');
    upsertSubscription({
      userId: 'u_author', stripeSubscriptionId: 'sub_test_1', stripeCustomerId: 'cus_test_1',
      status: 'active', priceId: AUTHOR_PRICE, currentPeriodEnd: new Date(Date.now() + 864e5).toISOString(),
    });

    const entitlement = resolveEntitlement('u_author');
    expect(entitlement).toMatchObject({ canCreateNovel: true, reason: 'subscription', plan: 'author', novelLimit: 3 });
    expect(assertCanCreateNovel('u_author').canCreateNovel).toBe(true);

    for (let i = 0; i < 3; i++) await createNovel('u_author', novelInput(`Book ${i}`));
    expect(resolveEntitlement('u_author')).toMatchObject({ novelsInProgress: 3, canCreateNovel: false, reason: 'novel_limit_reached' });
    await expect(createNovel('u_author', novelInput('Fourth'))).rejects.toThrowError(/reached its limit of novels in progress/i);
  });

  it('a completed novel frees a slot, and a bigger plan raises the limit', async () => {
    seedUser('u_studio', 'studio@example.com');
    upsertSubscription({
      userId: 'u_studio', stripeSubscriptionId: 'sub_studio', stripeCustomerId: 'cus_test_1',
      status: 'active', priceId: STUDIO_PRICE, currentPeriodEnd: new Date(Date.now() + 864e5).toISOString(),
    });
    expect(resolveEntitlement('u_studio')).toMatchObject({ plan: 'studio', novelLimit: 12 });

    const novel = await createNovel('u_studio', novelInput('Finished'));
    expect(resolveEntitlement('u_studio').novelsInProgress).toBe(1);
    getDb().prepare(`UPDATE novels SET status='completed' WHERE id=?`).run(novel.id);
    expect(resolveEntitlement('u_studio').novelsInProgress).toBe(0);
  });

  it('a past_due subscription is refused', () => {
    seedUser('u_past_due', 'pastdue@example.com');
    upsertSubscription({
      userId: 'u_past_due', stripeSubscriptionId: 'sub_pd', stripeCustomerId: 'cus_test_1',
      status: 'past_due', priceId: AUTHOR_PRICE,
    });
    expect(resolveEntitlement('u_past_due')).toMatchObject({ canCreateNovel: false, reason: 'subscription_inactive' });
  });

  it('a price id we do not sell grants nothing', () => {
    seedUser('u_unknown_price', 'unknown@example.com');
    upsertSubscription({
      userId: 'u_unknown_price', stripeSubscriptionId: 'sub_unknown', stripeCustomerId: 'cus_test_1',
      status: 'active', priceId: 'price_someone_elses',
    });
    const row = getDb().prepare('SELECT plan FROM subscriptions WHERE stripeSubscriptionId=?').get('sub_unknown') as any;
    expect(row.plan).toBe('unknown');
    expect(resolveEntitlement('u_unknown_price').canCreateNovel).toBe(false);
  });
});

describe('admin privileges', () => {
  it('the admin role creates novels for free', async () => {
    seedUser('u_admin', 'admin@example.com', 'admin');
    expect(isAdmin('u_admin')).toBe(true);
    const entitlement = resolveEntitlement('u_admin');
    expect(entitlement).toMatchObject({ canCreateNovel: true, reason: 'admin', freeAccess: true, freeAccessSource: 'admin' });
    expect(entitlement.novelLimit).toBe(Infinity);
    await expect(createNovel('u_admin', novelInput('Free'))).resolves.toMatchObject({ userId: 'u_admin' });
  });

  it('an administrator can grant and revoke free novel creation for another user, audited', async () => {
    seedUser('u_admin', 'admin@example.com', 'admin');
    seedUser('u_writer', 'writer@example.com');

    await expect(createNovel('u_writer', novelInput('Nope'))).rejects.toThrowError(/active plan is required/i);

    const granted = updateUserPrivileges('u_admin', 'u_writer', { freeNovelAccess: true });
    expect(granted).toMatchObject({ freeNovelAccess: true, freeNovelGrantedBy: 'u_admin', canCreateNovel: true });
    expect(granted.freeNovelGrantedAt).toBeTruthy();
    expect(resolveEntitlement('u_writer')).toMatchObject({ freeAccessSource: 'comp', reason: 'comp' });
    await expect(createNovel('u_writer', novelInput('Granted'))).resolves.toMatchObject({ title: 'Granted' });

    const revoked = updateUserPrivileges('u_admin', 'u_writer', { freeNovelAccess: false });
    expect(revoked).toMatchObject({ freeNovelAccess: false, canCreateNovel: false });
    expect(revoked.freeNovelGrantedAt).toBeNull();
    await expect(createNovel('u_writer', novelInput('Revoked'))).rejects.toThrowError(/active plan is required/i);

    const actions = listAuditLog().map(entry => entry.action);
    expect(actions).toContain('free_access_granted');
    expect(actions).toContain('free_access_revoked');
    const entries = listAuditLog() as any[];
    const grant = entries.find(e => e.action === 'free_access_granted');
    expect(grant.actorId).toBe('u_admin');
    expect(grant.targetUserId).toBe('u_writer');
  });

  it('an administrator can promote and demote users, but not themselves', () => {
    seedUser('u_admin', 'admin@example.com', 'admin');
    seedUser('u_admin2', 'admin2@example.com', 'admin');
    seedUser('u_writer', 'writer@example.com');

    expect(updateUserPrivileges('u_admin', 'u_writer', { role: 'admin' })).toMatchObject({ role: 'admin' });
    expect(isAdmin('u_writer')).toBe(true);
    expect(updateUserPrivileges('u_admin', 'u_writer', { role: 'user' })).toMatchObject({ role: 'user' });
    expect(isAdmin('u_writer')).toBe(false);

    let self: any;
    try { updateUserPrivileges('u_admin', 'u_admin', { role: 'user' }); } catch (err) { self = err; }
    expect(self).toBeInstanceOf(HttpError);
    expect(self.status).toBe(409);
    expect(self.code).toBe('cannot_modify_self');
    expect(isAdmin('u_admin')).toBe(true);
  });

  it('protects the deployment from losing its last administrator', () => {
    seedUser('u_admin', 'admin@example.com', 'admin');
    seedUser('u_admin2', 'admin2@example.com', 'admin');
    seedUser('u_writer', 'writer@example.com');
    expect(countAdmins()).toBe(2);

    // A non-admin cannot demote anyone.
    let untrusted: any;
    try { updateUserPrivileges('u_writer', 'u_admin', { role: 'user' }); } catch (err) { untrusted = err; }
    expect(untrusted.status).toBe(403);
    expect(isAdmin('u_admin')).toBe(true);

    // Demotion is allowed while another administrator remains, and the count
    // never reaches zero: `cannot_modify_self` stops the second admin.
    updateUserPrivileges('u_admin', 'u_admin2', { role: 'user' });
    expect(countAdmins()).toBe(1);
    let self: any;
    try { updateUserPrivileges('u_admin', 'u_admin', { role: 'user' }); } catch (err) { self = err; }
    expect(self.status).toBe(409);
    expect(self.code).toBe('cannot_modify_self');
    expect(countAdmins()).toBe(1);

    // The count also includes ADMIN_EMAILS accounts, so an env-listed address
    // keeps the invariant even if no database role is left.
    seedUser('u_env', 'envadmin@example.com');
    process.env.ADMIN_EMAILS = 'envadmin@example.com';
    updateUserPrivileges('u_env', 'u_admin', { role: 'user' });
    expect(countAdmins()).toBe(1);
    expect(isAdmin('u_env')).toBe(true);
    delete process.env.ADMIN_EMAILS;
  });

  it('non-admins cannot reach the admin API', () => {
    seedUser('u_writer', 'writer@example.com');
    let thrown: any;
    try { requireAdmin('u_writer'); } catch (err) { thrown = err; }
    expect(thrown.status).toBe(403);
    expect(thrown.code).toBe('admin_only');

    let update: any;
    try { updateUserPrivileges('u_writer', 'u_writer', { freeNovelAccess: true }); } catch (err) { update = err; }
    expect(update.status).toBe(403);
  });

  it('ADMIN_EMAILS bootstraps an administrator, and the promotion is persisted', () => {
    seedUser('u_bootstrap', 'boss@example.com');
    expect(isAdmin('u_bootstrap')).toBe(false);

    process.env.ADMIN_EMAILS = 'boss@example.com, other@example.com';
    expect(isAdmin('u_bootstrap')).toBe(true);
    expect(resolveEntitlement('u_bootstrap')).toMatchObject({ reason: 'admin', canCreateNovel: true });
    expect(getDb().prepare('SELECT role FROM users WHERE id=?').get('u_bootstrap')).toMatchObject({ role: 'admin' });

    // Deliberately sticky: removing the address from ADMIN_EMAILS does not
    // silently take admin rights away from a live account (that is an explicit
    // demotion through the console, which is audited).
    delete process.env.ADMIN_EMAILS;
    expect(isAdmin('u_bootstrap')).toBe(true);
  });

  it('the admin user list never leaks password material', () => {
    seedUser('u_admin', 'admin@example.com', 'admin');
    seedUser('u_writer', 'writer@example.com');
    const users = listUsersForAdmin({ limit: 10 });
    expect(users).toHaveLength(2);
    for (const user of users) {
      expect(Object.keys(user)).not.toContain('passwordHash');
      expect(JSON.stringify(user)).not.toContain('passwordHash');
    }
  });
});

describe('checkout and billing portal', () => {
  it('creates a Stripe Checkout session for a configured plan and stores nothing yet', async () => {
    seedUser('u_buyer', 'buyer@example.com');
    const result = await createCheckoutSession('u_buyer', 'studio');
    expect(result.url).toBe('https://checkout.stripe.test/cs_test_123');

    const call = fake.requests.find(r => r.path === '/v1/checkout/sessions');
    expect(call, 'checkout session must be created through Stripe').toBeTruthy();
    expect(call!.body.mode).toBe('subscription');
    expect(call!.body['line_items[0][price]']).toBe(STUDIO_PRICE);
    expect(call!.body.client_reference_id).toBe('u_buyer');
    expect(call!.body.metadata?.userId ?? call!.body['metadata[userId]']).toBe('u_buyer');
    // A Stripe customer is created for the account and remembered.
    const customerCall = fake.requests.find(r => r.path === '/v1/customers');
    expect(customerCall!.body.email).toBe('buyer@example.com');
    expect(getDb().prepare('SELECT stripeCustomerId FROM users WHERE id=?').get('u_buyer')).toMatchObject({ stripeCustomerId: 'cus_test_new' });
    // ...but no entitlement before Stripe confirms payment.
    expect(resolveEntitlement('u_buyer').canCreateNovel).toBe(false);
  });

  it('a plan whose price id is not configured is refused, not silently sold', async () => {
    seedUser('u_buyer', 'buyer@example.com');
    delete process.env.STRIPE_PRICE_STUDIO;
    let thrown: any;
    try { await createCheckoutSession('u_buyer', 'studio'); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown.status).toBe(503);
    expect(thrown.code).toBe('billing_not_configured');
    expect(fake.requests.some(r => r.path === '/v1/checkout/sessions')).toBe(false);
  });

  it('everything billing returns 503 while STRIPE_SECRET_KEY is absent', async () => {
    seedUser('u_buyer', 'buyer@example.com');
    const key = process.env.STRIPE_SECRET_KEY!;
    delete process.env.STRIPE_SECRET_KEY;
    resetStripeForTests();
    try {
      for (const call of [
        () => createCheckoutSession('u_buyer', 'author'),
        () => createPortalSession('u_buyer'),
      ]) {
        let thrown: any;
        try { await call(); } catch (err) { thrown = err; }
        expect(thrown.status).toBe(503);
        expect(thrown.code).toBe('billing_not_configured');
      }
      // Entitlements still work without Stripe — admins and comps are not blocked.
      seedUser('u_admin', 'admin@example.com', 'admin');
      expect(resolveEntitlement('u_admin').canCreateNovel).toBe(true);
    } finally {
      process.env.STRIPE_SECRET_KEY = key;
      resetStripeForTests();
    }
  });

  it('the portal needs an existing Stripe customer', async () => {
    seedUser('u_nocustomer', 'nocustomer@example.com');
    let thrown: any;
    try { await createPortalSession('u_nocustomer'); } catch (err) { thrown = err; }
    expect(thrown.status).toBe(409);
    expect(thrown.code).toBe('no_billing_account');

    seedUser('u_customer', 'customer@example.com');
    linkCustomer('u_customer', 'cus_test_1');
    upsertSubscription({
      userId: 'u_customer', stripeSubscriptionId: 'sub_c', stripeCustomerId: 'cus_test_1',
      status: 'active', priceId: AUTHOR_PRICE,
    });
    const portal = await createPortalSession('u_customer');
    expect(portal.url).toBe('https://billing.stripe.test/bps_test_1');
    const call = fake.requests.find(r => r.path === '/v1/billing_portal/sessions');
    expect(call!.body.customer).toBe('cus_test_1');
  });
});

describe('Stripe webhooks', () => {
  it('rejects a bad signature and never touches the database', async () => {
    const raw = JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } });
    let thrown: any;
    try { await processWebhook(raw, 't=1,v1=deadbeef'); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown.status).toBe(400);
    expect(thrown.code).toBe('invalid_signature');

    let missing: any;
    try { await processWebhook(raw, null); } catch (err) { missing = err; }
    expect(missing.status).toBe(400);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM stripe_events').get()).toMatchObject({ c: 0 });
  });

  it('checkout.session.completed activates the plan from the retrieved subscription', async () => {
    seedUser('u_buyer', 'buyer@example.com');
    fake.setSubscription(stripeSubscription({ id: 'sub_checkout', customer: 'cus_test_1' }));

    const outcome = await deliverWebhook({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', object: 'checkout.session', customer: 'cus_test_1', subscription: 'sub_checkout', client_reference_id: 'u_buyer', metadata: { userId: 'u_buyer' } } },
    });
    expect(outcome).toMatchObject({ received: true, handled: 'checkout.session.completed' });

    const entitlement = resolveEntitlement('u_buyer');
    expect(entitlement).toMatchObject({ canCreateNovel: true, plan: 'author', reason: 'subscription' });
    expect(getDb().prepare('SELECT stripeCustomerId FROM users WHERE id=?').get('u_buyer')).toMatchObject({ stripeCustomerId: 'cus_test_1' });
    expect(getDb().prepare('SELECT plan,status FROM subscriptions WHERE stripeSubscriptionId=?').get('sub_checkout')).toMatchObject({ plan: 'author', status: 'active' });
    expect(fake.requests.some(r => r.path === '/v1/subscriptions/sub_checkout')).toBe(true);
  });

  it('is idempotent: the same event id is never applied twice', async () => {
    seedUser('u_buyer', 'buyer@example.com');
    linkCustomer('u_buyer', 'cus_test_1');
    const event = {
      id: 'evt_duplicate',
      type: 'customer.subscription.created',
      data: { object: stripeSubscription({ id: 'sub_dup', customer: 'cus_test_1' }) },
    };
    const first = await deliverWebhook(event);
    expect(first).toMatchObject({ received: true, handled: 'customer.subscription.created' });

    // Change the payload under the same event id: a replay must not apply it.
    const second = await deliverWebhook({ ...event, data: { object: stripeSubscription({ id: 'sub_dup', customer: 'cus_test_1', items: { data: [{ price: { id: STUDIO_PRICE } }] } }) } });
    expect(second).toMatchObject({ received: true, duplicate: true });
    expect(getDb().prepare('SELECT plan FROM subscriptions WHERE stripeSubscriptionId=?').get('sub_dup')).toMatchObject({ plan: 'author' });
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM stripe_events WHERE id=?').get('evt_duplicate')).toMatchObject({ c: 1 });
  });

  it('a cancelled subscription removes the entitlement, and past_due blocks it', async () => {
    seedUser('u_buyer', 'buyer@example.com');
    linkCustomer('u_buyer', 'cus_test_1');
    await deliverWebhook({ id: 'evt_c1', type: 'customer.subscription.created', data: { object: stripeSubscription({ id: 'sub_life', customer: 'cus_test_1' }) } });
    expect(resolveEntitlement('u_buyer').canCreateNovel).toBe(true);

    await deliverWebhook({ id: 'evt_c2', type: 'invoice.payment_failed', data: { object: { id: 'in_1', object: 'invoice', customer: 'cus_test_1', subscription: 'sub_life' } } });
    expect(resolveEntitlement('u_buyer')).toMatchObject({ canCreateNovel: false, status: 'past_due' });

    // `deleted` means Stripe will not bill again: the row is forced to canceled
    // even if the payload still says the subscription is active.
    await deliverWebhook({ id: 'evt_c3', type: 'customer.subscription.deleted', data: { object: stripeSubscription({ id: 'sub_life', customer: 'cus_test_1', status: 'active' }) } });
    expect(resolveEntitlement('u_buyer')).toMatchObject({ canCreateNovel: false, status: 'canceled', reason: 'subscription_inactive' });

    // Re-subscribing restores access.
    await deliverWebhook({ id: 'evt_c4', type: 'customer.subscription.updated', data: { object: stripeSubscription({ id: 'sub_life', customer: 'cus_test_1', status: 'active' }) } });
    expect(resolveEntitlement('u_buyer').canCreateNovel).toBe(true);
  });

  it('an unknown price id grants nothing even when the event looks valid', async () => {
    seedUser('u_buyer', 'buyer@example.com');
    linkCustomer('u_buyer', 'cus_test_1');

    // A subscription on our customer that carries a price we do not sell.
    await deliverWebhook({
      id: 'evt_unknown_price',
      type: 'customer.subscription.created',
      data: { object: stripeSubscription({ id: 'sub_foreign', customer: 'cus_test_1', items: { data: [{ price: { id: 'price_not_ours' } }] } }) },
    });
    const sub = getDb().prepare('SELECT plan,userId FROM subscriptions WHERE stripeSubscriptionId=?').get('sub_foreign') as any;
    expect(sub).toMatchObject({ plan: 'unknown', userId: 'u_buyer' });
    expect(resolveEntitlement('u_buyer').canCreateNovel).toBe(false);

    // A subscription for a customer that belongs to nobody is ignored entirely.
    const orphan = await deliverWebhook({
      id: 'evt_orphan_customer',
      type: 'customer.subscription.created',
      data: { object: stripeSubscription({ id: 'sub_orphan', customer: 'cus_stranger' }) },
    });
    expect(orphan).toMatchObject({ received: true, ignored: 'unknown user' });
    expect(getDb().prepare('SELECT id FROM subscriptions WHERE stripeSubscriptionId=?').get('sub_orphan')).toBeUndefined();
  });

  it('metadata cannot upgrade a customer to a plan the price id does not match', async () => {
    seedUser('u_buyer', 'buyer@example.com');
    linkCustomer('u_buyer', 'cus_test_1');
    await deliverWebhook({
      id: 'evt_meta_lie',
      type: 'customer.subscription.created',
      data: {
        object: stripeSubscription({
          id: 'sub_meta', customer: 'cus_test_1', metadata: { userId: 'u_buyer', plan: 'studio' },
        }),
      },
    });
    expect(getDb().prepare('SELECT plan FROM subscriptions WHERE stripeSubscriptionId=?').get('sub_meta')).toMatchObject({ plan: 'author' });
    expect(resolveEntitlement('u_buyer')).toMatchObject({ plan: 'author', novelLimit: 3 });
  });

  it('ignores unrelated event types without failing', async () => {
    const outcome = await deliverWebhook({ id: 'evt_other', type: 'customer.updated', data: { object: { id: 'cus_test_1', object: 'customer' } } });
    expect(outcome).toMatchObject({ received: true, ignored: 'customer.updated' });
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM stripe_events WHERE id=?').get('evt_other')).toMatchObject({ c: 1 });
  });
});

describe('subscription rows', () => {
  it('one Stripe subscription updates its row instead of duplicating it', () => {
    seedUser('u_buyer', 'buyer@example.com');
    upsertSubscription({ userId: 'u_buyer', stripeSubscriptionId: 'sub_same', stripeCustomerId: 'cus_test_1', status: 'active', priceId: AUTHOR_PRICE });
    upsertSubscription({ userId: 'u_buyer', stripeSubscriptionId: 'sub_same', stripeCustomerId: 'cus_test_1', status: 'active', priceId: STUDIO_PRICE });
    const rows = getDb().prepare('SELECT plan,status FROM subscriptions WHERE stripeSubscriptionId=?').all('sub_same') as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].plan).toBe('studio');
  });

  it('a user switching plans ends up with the newer subscription active', () => {
    seedUser('u_buyer', 'buyer@example.com');
    upsertSubscription({ userId: 'u_buyer', stripeSubscriptionId: 'sub_old', stripeCustomerId: 'cus_test_1', status: 'canceled', priceId: AUTHOR_PRICE });
    upsertSubscription({ userId: 'u_buyer', stripeSubscriptionId: 'sub_new', stripeCustomerId: 'cus_test_1', status: 'active', priceId: STUDIO_PRICE });
    expect(resolveEntitlement('u_buyer')).toMatchObject({ plan: 'studio', status: 'active', canCreateNovel: true });
  });
});
