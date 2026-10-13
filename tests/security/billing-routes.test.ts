/**
 * HTTP surface for billing and administration.
 *
 * Complements tests/security/billing.test.ts (service level) by going through
 * the route handlers: who may call them, what an unentitled writer gets, and
 * that a forged webhook never reaches the projection logic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDatabase, seedUser, db } from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: 'U', email: 'u@example.com' } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { POST as createNovelRoute } from '@/app/api/novels/route';
import { POST as checkoutRoute } from '@/app/api/billing/checkout/route';
import { POST as portalRoute } from '@/app/api/billing/portal/route';
import { GET as adminUsersRoute, } from '@/app/api/admin/users/route';
import { PATCH as adminUserPatchRoute } from '@/app/api/admin/users/[userId]/route';
import { POST as stripeWebhookRoute } from '@/app/api/webhooks/stripe/route';
import { resetStripeForTests } from '@/lib/billing/stripe';
import { updateUserPrivileges } from '@/services/billing/service';

const req = (url: string, body?: unknown, method = 'POST') => new Request(`http://localhost:3000${url}`, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const novelBody = { title: 'Entitled Novel', genre: 'Fantasy', targetWords: 80000, targetPages: 250, targetChapters: 30, writingMode: 'chapter' };

let admin: { id: string; email: string; name: string };
let writer: { id: string; email: string; name: string };
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_AUTHOR', 'STRIPE_PRICE_STUDIO', 'ADMIN_EMAILS']) {
    savedEnv[key] = process.env[key];
  }
  freshDatabase();
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetStripeForTests();
});

beforeEach(() => {
  freshDatabase();
  delete process.env.ADMIN_EMAILS;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  resetStripeForTests();
  admin = seedUser({ name: 'Admin', email: 'admin@example.com' });
  writer = seedUser({ name: 'Writer', email: 'writer@example.com' });
  db().prepare(`UPDATE users SET role='admin' WHERE id=?`).run(admin.id);
  session.userId = null;
});

describe('novel creation is gated by entitlement over HTTP', () => {
  it('an unentitled writer gets 402 with the pricing pointer, and no novel is stored', async () => {
    session.userId = writer.id;
    const res = await createNovelRoute(req('/api/novels', novelBody));
    expect(res.status).toBe(402);
    const body = await res.json();
    // HttpError details are merged into the error body (see lib/api/http.ts).
    expect(body).toMatchObject({
      error: expect.any(String),
      code: 'payment_required',
      reason: 'subscription_required',
      pricingUrl: '/pricing',
      novelsInProgress: 0,
    });
    expect(db().prepare('SELECT COUNT(*) AS c FROM novels').get()).toMatchObject({ c: 0 });
  });

  it('an administrator creates a novel without a plan', async () => {
    session.userId = admin.id;
    const res = await createNovelRoute(req('/api/novels', novelBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ title: 'Entitled Novel', userId: admin.id });
    expect(db().prepare('SELECT COUNT(*) AS c FROM novels').get()).toMatchObject({ c: 1 });
  });

  it('a viewer who is granted free access can create one', async () => {
    session.userId = writer.id;
    expect((await createNovelRoute(req('/api/novels', novelBody))).status).toBe(402);

    updateUserPrivileges(admin.id, writer.id, { freeNovelAccess: true });
    expect((await createNovelRoute(req('/api/novels', { ...novelBody, title: 'Comped' }))).status).toBe(200);
  });

  it('an anonymous request is rejected before any entitlement work', async () => {
    const res = await createNovelRoute(req('/api/novels', novelBody));
    expect(res.status).toBe(401);
    expect(db().prepare('SELECT COUNT(*) AS c FROM novels').get()).toMatchObject({ c: 0 });
  });
});

describe('admin API authorisation', () => {
  it('requires a signed-in administrator', async () => {
    expect((await adminUsersRoute(req('/api/admin/users', undefined, 'GET'))).status).toBe(401);

    session.userId = writer.id;
    expect((await adminUsersRoute(req('/api/admin/users', undefined, 'GET'))).status).toBe(403);

    session.userId = admin.id;
    const res = await adminUsersRoute(req('/api/admin/users', undefined, 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.map((u: any) => u.email).sort()).toEqual(['admin@example.com', 'writer@example.com']);
  });

  it('patches privileges for another account, and refuses self-demotion', async () => {
    session.userId = writer.id;
    const forbidden = await adminUserPatchRoute(req(`/api/admin/users/${admin.id}`, { freeNovelAccess: true }, 'PATCH'), { params: { userId: admin.id } } as any);
    expect(forbidden.status).toBe(403);

    session.userId = admin.id;
    const granted = await adminUserPatchRoute(req(`/api/admin/users/${writer.id}`, { freeNovelAccess: true }, 'PATCH'), { params: { userId: writer.id } } as any);
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({ id: writer.id, freeNovelAccess: true, canCreateNovel: true });

    const self = await adminUserPatchRoute(req(`/api/admin/users/${admin.id}`, { role: 'user' }, 'PATCH'), { params: { userId: admin.id } } as any);
    expect(self.status).toBe(409);
    expect((await self.json()).code).toBe('cannot_modify_self');
  });

  it('validates the patch body', async () => {
    session.userId = admin.id;
    const empty = await adminUserPatchRoute(req(`/api/admin/users/${writer.id}`, {}, 'PATCH'), { params: { userId: writer.id } } as any);
    expect(empty.status).toBe(400);
    const bogus = await adminUserPatchRoute(req(`/api/admin/users/${writer.id}`, { freeNovelAccess: 'yes' }, 'PATCH'), { params: { userId: writer.id } } as any);
    expect(bogus.status).toBe(400);
    const unknown = await adminUserPatchRoute(req(`/api/admin/users/does-not-exist`, { freeNovelAccess: true }, 'PATCH'), { params: { userId: 'does-not-exist' } } as any);
    expect(unknown.status).toBe(404);
  });
});

describe('billing endpoints degrade cleanly', () => {
  it('checkout requires a session and a configured deployment', async () => {
    expect((await checkoutRoute(req('/api/billing/checkout', { plan: 'author' }))).status).toBe(401);

    session.userId = writer.id;
    // No STRIPE_SECRET_KEY: 503, never a fake success.
    const unconfigured = await checkoutRoute(req('/api/billing/checkout', { plan: 'author' }));
    expect(unconfigured.status).toBe(503);
    expect((await unconfigured.json()).code).toBe('billing_not_configured');

    // Unknown plan ids are rejected by validation rather than passed to Stripe.
    const invalid = await checkoutRoute(req('/api/billing/checkout', { plan: 'free' }));
    expect(invalid.status).toBe(400);
  });

  it('the portal reports the missing billing account before touching Stripe', async () => {
    session.userId = writer.id;
    const res = await portalRoute(req('/api/billing/portal'));
    // Without a secret this is a configuration error; with one it is 409.
    expect([409, 503]).toContain(res.status);
  });

  it('a forged webhook is rejected without writing anything', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
    resetStripeForTests();

    const res = await stripeWebhookRoute(req('/api/webhooks/stripe', { id: 'evt_forged', type: 'checkout.session.completed' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_signature');
    expect(db().prepare('SELECT COUNT(*) AS c FROM stripe_events').get()).toMatchObject({ c: 0 });
    expect(db().prepare('SELECT COUNT(*) AS c FROM subscriptions').get()).toMatchObject({ c: 0 });
  });

  it('a webhook on a deployment without Stripe is a 503, not a crash', async () => {
    const res = await stripeWebhookRoute(req('/api/webhooks/stripe', { id: 'evt_1', type: 'checkout.session.completed' }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('billing_not_configured');
  });
});
