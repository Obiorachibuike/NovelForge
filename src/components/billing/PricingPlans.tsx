'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Check, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { PlanId } from '@/lib/billing/plans';

export interface PlanView {
  id: PlanId;
  name: string;
  tagline: string;
  priceUsd: number;
  novelLimit: number;
  features: string[];
  recommended?: boolean;
  purchasable: boolean;
}

/**
 * Plan cards + checkout.
 *
 * The price ids live on the server; this component only sends a plan id, and
 * the browser is sent to the Stripe-hosted Checkout page (no card data ever
 * touches NovelForge).
 */
export default function PricingPlans({
  plans,
  signedIn,
  currentPlan,
  freeAccess,
}: {
  plans: PlanView[];
  signedIn: boolean;
  currentPlan: PlanId | null;
  freeAccess: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<PlanId | null>(null);

  async function choose(plan: PlanView) {
    if (!plan.purchasable) {
      toast.error(`${plan.name} is not connected to Stripe yet. See docs/billing.md.`);
      return;
    }
    if (!signedIn) {
      router.push(`/register?callbackUrl=${encodeURIComponent('/pricing')}`);
      return;
    }
    setPending(plan.id);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: plan.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || 'Could not start checkout.');
        return;
      }
      // Stripe hosts the payment page.
      window.location.href = data.url;
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid md:grid-cols-2 gap-6 max-w-4xl mx-auto">
      {plans.map(plan => {
        const isCurrent = currentPlan === plan.id;
        return (
          <div key={plan.id} className={cn('surface p-7 flex flex-col', plan.recommended && 'border-primary shadow-[0_0_0_1px_hsl(var(--primary))]')}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-serif text-2xl font-semibold">{plan.name}</h2>
              {plan.recommended && <span className="chip chip-primary">Most popular</span>}
              {isCurrent && <span className="chip chip-success">Current plan</span>}
            </div>
            <p className="text-sm text-muted-foreground mb-5">{plan.tagline}</p>
            <div className="mb-6">
              <span className="font-serif text-4xl font-semibold">${plan.priceUsd}</span>
              <span className="text-muted-foreground text-sm"> / month</span>
              <div className="text-xs text-muted-foreground mt-1">Up to {plan.novelLimit} novels in progress · cancel anytime</div>
            </div>
            <ul className="space-y-2.5 text-sm flex-1 mb-7">
              {plan.features.map(f => (
                <li key={f} className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <button
              className={cn('w-full', plan.recommended ? 'btn-primary' : 'btn-outline')}
              disabled={pending !== null || freeAccess}
              onClick={() => choose(plan)}
              title={freeAccess ? 'Your account already has free novel creation' : undefined}
            >
              {pending === plan.id
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Opening checkout…</>
                : <><Sparkles className="w-4 h-4" /> {isCurrent ? 'Manage subscription' : `Choose ${plan.name}`}</>}
            </button>
          </div>
        );
      })}
    </div>
  );
}
