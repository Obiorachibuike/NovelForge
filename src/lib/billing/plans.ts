/**
 * Plan catalogue.
 *
 * Display metadata (name, price, limits) lives here; the Stripe **price ids**
 * live in environment variables so the same build can point at test or live
 * Stripe products. The numbers below must match the products you create in
 * Stripe — see docs/billing.md.
 *
 * There is deliberately no free plan: novel creation requires an entitlement,
 * which comes from an active subscription, an admin comp, or the admin role.
 */
export type PlanId = 'author' | 'studio';

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** Monthly price in USD, for display only. */
  priceUsd: number;
  /** Simultaneous novels in progress (a novel stops counting once completed). */
  novelLimit: number;
  features: string[];
  /** Environment variable holding the Stripe price id for this plan. */
  priceEnv: string;
  recommended?: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  author: {
    id: 'author',
    name: 'Author',
    tagline: 'For one novel at a time, done properly.',
    priceUsd: 12,
    novelLimit: 3,
    features: [
      'Up to 3 novels in progress',
      'Full sequential writing workflow',
      'Story Bible, memory and consistency checks',
      'Covers, exports (DOCX, PDF, EPUB, TXT, MD)',
      'AI usage included up to the daily budget',
    ],
    priceEnv: 'STRIPE_PRICE_AUTHOR',
  },
  studio: {
    id: 'studio',
    name: 'Studio',
    tagline: 'For a full series or a busy schedule.',
    priceUsd: 29,
    novelLimit: 12,
    features: [
      'Up to 12 novels in progress',
      'Everything in Author',
      'Higher AI budget and image generations',
      'Priority background worker slots',
      'Email support with manuscript questions',
    ],
    priceEnv: 'STRIPE_PRICE_STUDIO',
    recommended: true,
  },
};

export const PLAN_LIST: Plan[] = [PLANS.author, PLANS.studio];

export function isPlanId(value: unknown): value is PlanId {
  return value === 'author' || value === 'studio';
}

export function planById(value: unknown): Plan | null {
  return isPlanId(value) ? PLANS[value] : null;
}

/** Stripe price id configured for a plan, or null when billing is not set up. */
export function planPriceId(planId: PlanId, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[PLANS[planId].priceEnv];
  return value && value.trim() ? value.trim() : null;
}

/** Reverse lookup used by Stripe webhooks: price id → plan. */
export function planForPriceId(priceId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Plan | null {
  if (!priceId) return null;
  return PLAN_LIST.find(plan => planPriceId(plan.id, env) === priceId) ?? null;
}

/** Whether every plan has a configured price id (i.e. checkout can be offered). */
export function billingCatalogReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return PLAN_LIST.every(plan => planPriceId(plan.id, env) !== null);
}

/** Plans a given Stripe key/price set can actually sell, for the pricing page. */
export function purchasablePlans(env: NodeJS.ProcessEnv = process.env): Plan[] {
  return PLAN_LIST.filter(plan => planPriceId(plan.id, env) !== null);
}
