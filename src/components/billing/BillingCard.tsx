'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useRouter, useSearchParams } from 'next/navigation';
import { CreditCard, ExternalLink, Loader2, Sparkles, ShieldCheck } from 'lucide-react';

/**
 * Subscription panel for /settings.
 *
 * The portal button is only rendered when a Stripe customer exists; the server
 * decides that, so a fresh account is pointed at the pricing page instead of a
 * button that would 409.
 */
export default function BillingCard({
  label,
  detail,
  hasCustomer,
  canCreateNovel,
  planName,
  checkoutResult,
}: {
  label: string;
  detail: string;
  hasCustomer: boolean;
  canCreateNovel: boolean;
  planName: string | null;
  checkoutResult?: string | null;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const [pending, setPending] = useState(false);
  const result = checkoutResult ?? search.get('checkout');

  async function openPortal() {
    setPending(true);
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || 'Could not open the billing portal.');
        return;
      }
      window.location.href = data.url;
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="surface p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-serif text-lg font-semibold mb-1">Plan &amp; billing</h3>
          <div className="flex items-center gap-2">
            <span className="chip chip-primary">{label}</span>
            {canCreateNovel && <span className="chip chip-success"><ShieldCheck className="w-3 h-3" /> Can create novels</span>}
          </div>
          <p className="text-sm text-muted-foreground mt-2">{detail}</p>
          {planName && <p className="text-xs text-muted-foreground mt-1 capitalize">{planName} plan</p>}
        </div>
        <div className="flex flex-col items-end gap-2">
          {hasCustomer ? (
            <button className="btn-outline" onClick={openPortal} disabled={pending}>
              {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
              Manage subscription
              <ExternalLink className="w-3 h-3" />
            </button>
          ) : (
            <Link href="/pricing" className="btn-primary"><Sparkles className="w-4 h-4" /> See plans</Link>
          )}
        </div>
      </div>
      {result === 'success' && (
        <p className="mt-4 text-sm text-emerald-300">
          Payment received. Your subscription activates as soon as Stripe confirms the checkout — refresh in a moment if
          the plan above still looks unchanged.
        </p>
      )}
      {result === 'cancelled' && (
        <p className="mt-4 text-sm text-muted-foreground">Checkout was cancelled — nothing was charged.</p>
      )}
    </div>
  );
}
