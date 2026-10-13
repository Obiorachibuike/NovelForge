import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import { HttpError } from '@/lib/api/http';
import { getStripe, parseWebhookEvent, stripeConfigured } from '@/lib/billing/stripe';
import { PLANS, planById, planForPriceId, planPriceId, type PlanId } from '@/lib/billing/plans';
import 'server-only';

/**
 * Billing, entitlements and admin grants.
 *
 * The rule this module enforces: a novel can be created only when the account
 * is **entitled** — an admin, a user the admin comped, or an active Stripe
 * subscription that has not reached its novel limit. Everything is derived from
 * the database, so entitlements survive restarts and are identical in every
 * process.
 */

export type UserRole = 'user' | 'admin';
export type SubscriptionStatus =
  | 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete' | 'incomplete_expired' | 'unknown';

/** Statuses that actually grant novel creation. Everything else is refused. */
const ENTITLED_STATUSES: SubscriptionStatus[] = ['active', 'trialing'];
const INACTIVE_STATUSES: SubscriptionStatus[] = ['past_due', 'unpaid', 'incomplete', 'incomplete_expired'];

export interface Entitlement {
  userId: string;
  role: UserRole;
  email: string | null;
  name: string | null;
  isAdmin: boolean;
  /** Admin or comped: novel creation is free and unlimited. */
  freeAccess: boolean;
  freeAccessSource: 'admin' | 'comp' | null;
  plan: PlanId | null;
  planName: string | null;
  status: SubscriptionStatus | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasCustomer: boolean;
  /** `Infinity` for free access; the plan limit otherwise. */
  novelLimit: number;
  novelsInProgress: number;
  canCreateNovel: boolean;
  reason: EntitlementReason;
}

export type EntitlementReason =
  | 'admin'
  | 'comp'
  | 'subscription'
  | 'subscription_required'
  | 'subscription_inactive'
  | 'novel_limit_reached';

/** Emails in `ADMIN_EMAILS` are treated as administrators. */
export function adminEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Bootstrap: promotes an account whose e-mail is listed in `ADMIN_EMAILS`.
 *
 * Called on every entitlement lookup so a fresh deployment can create its first
 * admin simply by setting the variable — no SQL, no unauthenticated endpoint.
 */
function syncAdminRole(row: { id: string; email: string | null; role?: string | null }): boolean {
  const isAdmin = row.role === 'admin' || (!!row.email && adminEmails().includes(row.email.toLowerCase()));
  if (isAdmin && row.role !== 'admin') {
    getDb().prepare(`UPDATE users SET role='admin', updatedAt=? WHERE id=?`).run(new Date().toISOString(), row.id);
    console.log(`[billing] granted admin role to ${row.email} (ADMIN_EMAILS)`);
  }
  return isAdmin;
}

export function countNovelsInProgress(userId: string): number {
  const db = getDb();
  return (db.prepare(`SELECT COUNT(*) AS c FROM novels WHERE userId=? AND status != 'completed'`).get(userId) as any).c;
}

export interface SubscriptionRow {
  id: string;
  userId: string;
  plan: string;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: number;
  createdAt: string;
  updatedAt: string;
}

export function getSubscription(userId: string): SubscriptionRow | null {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM subscriptions WHERE userId=? ORDER BY updatedAt DESC').all(userId) as SubscriptionRow[];
  if (!rows.length) return null;
  // Prefer a subscription that currently entitles the account.
  const byId = new Map<string, SubscriptionRow>();
  for (const row of rows) if (row.stripeSubscriptionId) byId.set(row.stripeSubscriptionId, row);
  const candidates = [...byId.values()];
  return (
    candidates.find(r => ENTITLED_STATUSES.includes(r.status as SubscriptionStatus)) ??
    candidates[0] ??
    rows[0]
  );
}

export function resolveEntitlement(userId: string): Entitlement {
  const db = getDb();
  const user = db.prepare('SELECT id, name, email, role, freeNovelAccess, stripeCustomerId FROM users WHERE id=?').get(userId) as any;
  if (!user) throw new HttpError(404, 'User not found', 'user_not_found');

  const isAdmin = syncAdminRole(user);
  const comped = !!user.freeNovelAccess;
  const subscription = getSubscription(userId);
  const plan = subscription ? planById(subscription.plan) : null;
  const status = (subscription?.status as SubscriptionStatus) ?? null;
  const novelsInProgress = countNovelsInProgress(userId);

  const base = {
    userId,
    role: (isAdmin ? 'admin' : 'user') as UserRole,
    email: user.email ?? null,
    name: user.name ?? null,
    isAdmin,
    hasCustomer: !!user.stripeCustomerId,
    novelsInProgress,
    plan: plan?.id ?? null,
    planName: plan?.name ?? null,
    status,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: !!subscription?.cancelAtPeriodEnd,
  };

  if (isAdmin) {
    return { ...base, freeAccess: true, freeAccessSource: 'admin', novelLimit: Infinity, canCreateNovel: true, reason: 'admin' };
  }
  if (comped) {
    return { ...base, freeAccess: true, freeAccessSource: 'comp', novelLimit: Infinity, canCreateNovel: true, reason: 'comp' };
  }

  const novelLimit = plan?.novelLimit ?? 0;
  if (!plan || !status) {
    return { ...base, freeAccess: false, freeAccessSource: null, novelLimit, canCreateNovel: false, reason: 'subscription_required' };
  }
  if (!ENTITLED_STATUSES.includes(status)) {
    return { ...base, freeAccess: false, freeAccessSource: null, novelLimit, canCreateNovel: false, reason: 'subscription_inactive' };
  }
  const canCreateNovel = novelsInProgress < novelLimit;
  return {
    ...base,
    freeAccess: false,
    freeAccessSource: null,
    novelLimit,
    canCreateNovel,
    reason: canCreateNovel ? 'subscription' : 'novel_limit_reached',
  };
}

const REASON_MESSAGES: Record<EntitlementReason, string> = {
  admin: 'Administrator accounts create novels for free.',
  comp: 'This account has free novel access granted by an administrator.',
  subscription: '',
  subscription_required: 'An active plan is required to create a novel. Choose a plan to continue.',
  subscription_inactive: 'Your subscription is not active any more. Update billing to keep creating novels.',
  novel_limit_reached: 'Your plan has reached its limit of novels in progress. Finish or archive a novel, or upgrade.',
};

/**
 * Throws 402 `payment_required` (with the reason) unless the account may create
 * a novel. Admins and comped accounts always pass.
 */
export function assertCanCreateNovel(userId: string): Entitlement {
  const entitlement = resolveEntitlement(userId);
  if (entitlement.canCreateNovel) return entitlement;
  throw new HttpError(402, REASON_MESSAGES[entitlement.reason], 'payment_required', {
    reason: entitlement.reason,
    plan: entitlement.plan,
    novelLimit: Number.isFinite(entitlement.novelLimit) ? entitlement.novelLimit : null,
    novelsInProgress: entitlement.novelsInProgress,
    pricingUrl: '/pricing',
  });
}

// ---------------------------------------------------------------------------
// Stripe: checkout, portal and webhook projection
// ---------------------------------------------------------------------------

export interface CheckoutResult { url: string; sessionId: string }

function appUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}${path}`;
}

/** Finds (or creates) the Stripe customer for a user and remembers its id. */
async function ensureCustomer(userId: string): Promise<string> {
  const stripe = getStripe();
  if (!stripe) throw new HttpError(503, 'Billing is not configured on this deployment.', 'billing_not_configured');

  const db = getDb();
  const user = db.prepare('SELECT id, name, email, stripeCustomerId FROM users WHERE id=?').get(userId) as any;
  if (!user) throw new HttpError(404, 'User not found', 'user_not_found');
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: user.email || undefined,
    name: user.name || undefined,
    metadata: { userId },
  });
  db.prepare('UPDATE users SET stripeCustomerId=?, updatedAt=? WHERE id=?')
    .run(customer.id, new Date().toISOString(), userId);
  return customer.id;
}

/** Creates a subscription Checkout Session. The plan comes from our catalogue. */
export async function createCheckoutSession(userId: string, planId: PlanId): Promise<CheckoutResult> {
  const plan = planById(planId);
  if (!plan) throw new HttpError(400, 'Unknown plan.', 'unknown_plan');
  const priceId = planPriceId(plan.id);
  if (!priceId) {
    throw new HttpError(
      503,
      `Plan "${plan.name}" is not connected to Stripe yet (set ${plan.priceEnv}). See docs/billing.md.`,
      'billing_not_configured',
    );
  }
  const stripe = getStripe();
  if (!stripe) throw new HttpError(503, 'Billing is not configured on this deployment.', 'billing_not_configured');

  const customerId = await ensureCustomer(userId);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: appUrl('/settings?checkout=success'),
    cancel_url: appUrl('/pricing?checkout=cancelled'),
    client_reference_id: userId,
    allow_promotion_codes: true,
    metadata: { userId, plan: plan.id },
    subscription_data: { metadata: { userId, plan: plan.id } },
  });

  if (!session.url) throw new HttpError(502, 'Stripe did not return a checkout URL.', 'stripe_error');
  return { url: session.url, sessionId: session.id };
}

/** Stripe Billing Portal for the customer attached to this user. */
export async function createPortalSession(userId: string): Promise<{ url: string }> {
  const stripe = getStripe();
  if (!stripe) throw new HttpError(503, 'Billing is not configured on this deployment.', 'billing_not_configured');

  const db = getDb();
  const user = db.prepare('SELECT stripeCustomerId FROM users WHERE id=?').get(userId) as any;
  if (!user) throw new HttpError(404, 'User not found', 'user_not_found');
  if (!user.stripeCustomerId) {
    throw new HttpError(409, 'This account has no billing history yet.', 'no_billing_account');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: appUrl('/settings'),
  });
  if (!session.url) throw new HttpError(502, 'Stripe did not return a portal URL.', 'stripe_error');
  return { url: session.url };
}

function mapStatus(status: string | null | undefined): SubscriptionStatus {
  const value = String(status || '').toLowerCase();
  if (['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired'].includes(value)) {
    return value as SubscriptionStatus;
  }
  return 'unknown';
}

export interface UpsertSubscriptionInput {
  userId: string;
  stripeSubscriptionId: string;
  stripeCustomerId?: string | null;
  priceId?: string | null;
  status: string;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
}

/**
 * Projects a Stripe subscription onto our table.
 *
 * The plan is resolved from the **price id we configured**, never from the
 * event payload's own labels, so a crafted metadata value cannot upgrade an
 * account. An unrecognised price is stored as `unknown` and grants nothing.
 */
export function upsertSubscription(input: UpsertSubscriptionInput): SubscriptionRow {
  const db = getDb();
  const now = new Date().toISOString();
  const plan = planForPriceId(input.priceId);
  if (!plan && input.priceId) {
    console.warn(`[billing] subscription ${input.stripeSubscriptionId} uses unknown price ${input.priceId}; no entitlement granted.`);
  }
  const existing = db.prepare('SELECT * FROM subscriptions WHERE stripeSubscriptionId=?')
    .get(input.stripeSubscriptionId) as SubscriptionRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE subscriptions SET plan=?, status=?, priceId=?, currentPeriodEnd=?, cancelAtPeriodEnd=?,
                                stripeCustomerId=COALESCE(?, stripeCustomerId), updatedAt=?
        WHERE stripeSubscriptionId=?`,
    ).run(
      plan?.id ?? 'unknown', mapStatus(input.status), input.priceId ?? null,
      input.currentPeriodEnd ?? null, input.cancelAtPeriodEnd ? 1 : 0,
      input.stripeCustomerId ?? null, now, input.stripeSubscriptionId,
    );
    return db.prepare('SELECT * FROM subscriptions WHERE stripeSubscriptionId=?').get(input.stripeSubscriptionId) as SubscriptionRow;
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO subscriptions (id,userId,plan,status,stripeCustomerId,stripeSubscriptionId,priceId,currentPeriodEnd,cancelAtPeriodEnd,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, input.userId, plan?.id ?? 'unknown', mapStatus(input.status), input.stripeCustomerId ?? null,
    input.stripeSubscriptionId, input.priceId ?? null, input.currentPeriodEnd ?? null,
    input.cancelAtPeriodEnd ? 1 : 0, now, now,
  );
  return db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id) as SubscriptionRow;
}

/** Resolves the account a Stripe customer belongs to. */
export function userIdForCustomer(customerId: string | null | undefined): string | null {
  if (!customerId) return null;
  const db = getDb();
  const row = db.prepare('SELECT id FROM users WHERE stripeCustomerId=?').get(customerId) as any;
  if (row?.id) return row.id as string;
  const sub = db.prepare('SELECT userId FROM subscriptions WHERE stripeCustomerId=? LIMIT 1').get(customerId) as any;
  return sub?.userId ?? null;
}

export interface WebhookOutcome { received: true; duplicate?: boolean; handled?: string; ignored?: string }

/**
 * Handles a verified Stripe event.
 *
 * Idempotent by event id: Stripe retries deliveries, and an entitlement must
 * never be granted twice from the retry of one event.
 */
export async function handleStripeEvent(event: { id: string; type: string; data: any }): Promise<WebhookOutcome> {
  const db = getDb();

  const inserted = db.prepare(
    `INSERT INTO stripe_events (id,type,processedAt) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING`,
  ).run(event.id, event.type, new Date().toISOString());
  if (inserted.changes === 0) return { received: true, duplicate: true };

  const object = event.data?.object ?? {};

  switch (event.type) {
    case 'checkout.session.completed': {
      const userId: string | null = object.client_reference_id ?? object.metadata?.userId ?? userIdForCustomer(object.customer);
      if (!userId || !db.prepare('SELECT id FROM users WHERE id=?').get(userId)) {
        console.warn(`[billing] checkout.session.completed for unknown user ${userId ?? '(none)'}`);
        return { received: true, ignored: 'unknown user' };
      }
      if (object.customer) {
        db.prepare('UPDATE users SET stripeCustomerId=?, updatedAt=? WHERE id=?')
          .run(object.customer, new Date().toISOString(), userId);
      }
      if (object.subscription) {
        // Ask Stripe for the authoritative subscription object rather than
        // trusting the (thinner) session payload for price/status/period.
        const stripe = getStripe();
        if (stripe) {
          try {
            const subscription: any = await stripe.subscriptions.retrieve(String(object.subscription));
            projectSubscription(subscription, { userId, customerId: object.customer });
          } catch (err) {
            console.warn('[billing] could not load the subscription for a completed checkout:', err);
          }
        }
      }
      return { received: true, handled: event.type };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = object;
      const userId = subscription.metadata?.userId || userIdForCustomer(subscription.customer);
      if (!userId || !db.prepare('SELECT id FROM users WHERE id=?').get(userId)) {
        console.warn(`[billing] ${event.type} for unknown user (customer ${subscription.customer})`);
        return { received: true, ignored: 'unknown user' };
      }
      // A deleted subscription is recorded as canceled regardless of the
      // status Stripe reported on the event.
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status;
      projectSubscription({ ...subscription, status }, { userId, customerId: subscription.customer });
      return { received: true, handled: event.type };
    }

    case 'invoice.payment_failed': {
      const subscriptionId = object.subscription ? String(object.subscription) : null;
      if (!subscriptionId) return { received: true, ignored: 'no subscription on invoice' };
      const updated = db.prepare(
        `UPDATE subscriptions SET status='past_due', updatedAt=? WHERE stripeSubscriptionId=?`,
      ).run(new Date().toISOString(), subscriptionId);
      if (!updated.changes) {
        const userId = userIdForCustomer(object.customer);
        if (userId) {
          upsertSubscription({
            userId, stripeSubscriptionId: subscriptionId,
            stripeCustomerId: object.customer ?? null, priceId: null, status: 'past_due',
          });
        }
      }
      return { received: true, handled: event.type };
    }

    default:
      return { received: true, ignored: event.type };
  }
}

/** Shared projection used by both the checkout and the subscription events. */
function projectSubscription(
  subscription: any,
  ctx: { userId: string; customerId?: string | null },
) {
  const item = subscription?.items?.data?.[0] ?? subscription?.items?.[0];
  const priceId: string | null = item?.price?.id ?? item?.price ?? null;
  const periodEndRaw = subscription?.current_period_end;
  const currentPeriodEnd = periodEndRaw
    ? new Date(Number(periodEndRaw) * 1000).toISOString()
    : null;

  return upsertSubscription({
    userId: ctx.userId,
    stripeSubscriptionId: String(subscription.id),
    stripeCustomerId: ctx.customerId ?? subscription.customer ?? null,
    priceId,
    status: String(subscription.status ?? 'unknown'),
    currentPeriodEnd,
    cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
  });
}

/** Verifies + handles a raw webhook request body. Throws HttpError on failure. */
export async function processWebhook(rawBody: string, signature: string | null): Promise<WebhookOutcome> {
  if (!stripeConfigured()) {
    throw new HttpError(503, 'Billing is not configured on this deployment.', 'billing_not_configured');
  }
  let event: any;
  try {
    event = parseWebhookEvent(rawBody, signature);
  } catch (err) {
    console.warn('[billing] rejected webhook:', err instanceof Error ? err.message : err);
    throw new HttpError(400, 'Invalid Stripe signature.', 'invalid_signature');
  }
  return handleStripeEvent(event);
}

// ---------------------------------------------------------------------------
// Admin: user administration and free-access grants
// ---------------------------------------------------------------------------

export function isAdmin(userId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT id, email, role FROM users WHERE id=?').get(userId) as any;
  if (!row) return false;
  return syncAdminRole(row);
}

/** Throws 403 unless the caller is an administrator. */
export function requireAdmin(userId: string): void {
  if (!isAdmin(userId)) throw new HttpError(403, 'Administrator access is required.', 'admin_only');
}

/** Accounts with administrator rights, counting both the role and ADMIN_EMAILS. */
export function countAdmins(): number {
  const db = getDb();
  const emails = adminEmails();
  const placeholders = emails.map(() => '?').join(',');
  const sql = emails.length
    ? `SELECT COUNT(*) AS c FROM users WHERE role='admin' OR lower(email) IN (${placeholders})`
    : `SELECT COUNT(*) AS c FROM users WHERE role='admin'`;
  return (db.prepare(sql).get(...emails) as any).c;
}

function audit(actorId: string, targetUserId: string | null, action: string, details?: unknown) {
  getDb().prepare(
    'INSERT INTO admin_audit_log (id,actorId,targetUserId,action,details,createdAt) VALUES (?,?,?,?,?,?)',
  ).run(nanoid(), actorId, targetUserId, action, details ? JSON.stringify(details) : null, new Date().toISOString());
}

export interface AdminUserView {
  id: string;
  name: string | null;
  email: string | null;
  role: UserRole;
  freeNovelAccess: boolean;
  freeNovelGrantedBy: string | null;
  freeNovelGrantedAt: string | null;
  novelsInProgress: number;
  plan: PlanId | null;
  status: SubscriptionStatus | null;
  currentPeriodEnd: string | null;
  canCreateNovel: boolean;
  reason: EntitlementReason;
  image: string | null;
  createdAt: string;
}

/** User directory for the admin console (no password material is returned). */
export function listUsersForAdmin(options: { query?: string; limit?: number } = {}): AdminUserView[] {
  const db = getDb();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const query = (options.query || '').trim().toLowerCase();
  const rows = (query
    ? db.prepare(
        `SELECT id,name,email,image,role,freeNovelAccess,freeNovelGrantedBy,freeNovelGrantedAt,createdAt
           FROM users WHERE lower(email) LIKE ? OR lower(name) LIKE ? ORDER BY createdAt DESC LIMIT ?`,
      ).all(`%${query}%`, `%${query}%`, limit)
    : db.prepare(
        `SELECT id,name,email,image,role,freeNovelAccess,freeNovelGrantedBy,freeNovelGrantedAt,createdAt
           FROM users ORDER BY createdAt DESC LIMIT ?`,
      ).all(limit)) as any[];

  return rows.map(row => {
    const entitlement = resolveEntitlement(row.id);
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: entitlement.role,
      freeNovelAccess: !!row.freeNovelAccess,
      freeNovelGrantedBy: row.freeNovelGrantedBy ?? null,
      freeNovelGrantedAt: row.freeNovelGrantedAt ?? null,
      novelsInProgress: entitlement.novelsInProgress,
      plan: entitlement.plan,
      status: entitlement.status,
      currentPeriodEnd: entitlement.currentPeriodEnd,
      canCreateNovel: entitlement.canCreateNovel,
      reason: entitlement.reason,
      image: row.image,
      createdAt: row.createdAt,
    };
  });
}

export interface AdminUpdateInput {
  role?: UserRole;
  freeNovelAccess?: boolean;
}

/**
 * Applies an administrator's change to a user's privileges.
 *
 * Guard rails: an admin cannot change their own role (accidental lock-out) and
 * the last remaining admin cannot be demoted. Every change is audited.
 */
export function updateUserPrivileges(actorId: string, targetUserId: string, input: AdminUpdateInput): AdminUserView {
  requireAdmin(actorId);
  const db = getDb();
  const target = db.prepare('SELECT id,email,role,freeNovelAccess FROM users WHERE id=?').get(targetUserId) as any;
  if (!target) throw new HttpError(404, 'User not found', 'user_not_found');

  if (input.role !== undefined) {
    if (targetUserId === actorId) {
      throw new HttpError(409, 'You cannot change your own role.', 'cannot_modify_self');
    }
    if (input.role === 'user') {
      const otherAdmins = (db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role='admin' AND id != ?`).get(targetUserId) as any).c;
      const emailAdmins = adminEmails().filter(email => email !== (target.email || '').toLowerCase()).length;
      if (otherAdmins === 0 && emailAdmins === 0) {
        throw new HttpError(409, 'At least one administrator must remain.', 'last_admin');
      }
    }
    db.prepare('UPDATE users SET role=?, updatedAt=? WHERE id=?')
      .run(input.role, new Date().toISOString(), targetUserId);
    audit(actorId, targetUserId, 'role_changed', { from: target.role, to: input.role });
  }

  if (input.freeNovelAccess !== undefined) {
    const now = new Date().toISOString();
    if (input.freeNovelAccess) {
      db.prepare('UPDATE users SET freeNovelAccess=1, freeNovelGrantedBy=?, freeNovelGrantedAt=?, updatedAt=? WHERE id=?')
        .run(actorId, now, now, targetUserId);
      audit(actorId, targetUserId, 'free_access_granted');
    } else {
      db.prepare('UPDATE users SET freeNovelAccess=0, freeNovelGrantedBy=NULL, freeNovelGrantedAt=NULL, updatedAt=? WHERE id=?')
        .run(now, targetUserId);
      audit(actorId, targetUserId, 'free_access_revoked');
    }
  }

  const view = listUsersForAdmin({ limit: 200 }).find(u => u.id === targetUserId);
  if (!view) throw new HttpError(404, 'User not found', 'user_not_found');
  return view;
}

export interface AuditRow {
  id: string;
  actorId: string;
  targetUserId: string | null;
  action: string;
  details: string | null;
  createdAt: string;
}

export function listAuditLog(limit = 50): AuditRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM admin_audit_log ORDER BY createdAt DESC LIMIT ?').all(Math.min(limit, 200)) as AuditRow[];
}

/** Human-readable billing status for the settings page. */
export function entitlementSummary(userId: string): { label: string; detail: string } {
  const e = resolveEntitlement(userId);
  if (e.freeAccessSource === 'admin') return { label: 'Administrator', detail: 'Novels are free on this account.' };
  if (e.freeAccessSource === 'comp') return { label: 'Free access (granted)', detail: 'An administrator granted free novel creation.' };
  if (e.planName) {
    const limit = Number.isFinite(e.novelLimit) ? `${e.novelLimit} novels in progress` : 'unlimited novels';
    const detail = e.status === 'active' || e.status === 'trialing'
      ? `Up to ${limit}${e.currentPeriodEnd ? ` · renews/ends ${e.currentPeriodEnd.slice(0, 10)}` : ''}`
      : `Subscription ${e.status} — novel creation is paused until billing is resolved.`;
    return { label: `${e.planName} plan`, detail };
  }
  return { label: 'No plan', detail: 'Choose a plan to start creating novels.' };
}

export { PLANS };
