import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/config';
import { PLAN_LIST, planPriceId } from '@/lib/billing/plans';
import { resolveEntitlement } from '@/services/billing/service';
import PricingPlans, { type PlanView } from '@/components/billing/PricingPlans';
import { BookOpen, ShieldCheck, Lock, Undo2 } from 'lucide-react';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Pricing · NovelForge' };

/**
 * Public pricing page.
 *
 * Prices are display metadata from the plan catalogue; whether a plan can
 * actually be bought is decided by whether its Stripe price id is configured,
 * and the button says so instead of failing at checkout.
 */
export default async function PricingPage() {
  const session = (await auth()) as any;
  const signedIn = !!session?.user?.id;
  const entitlement = signedIn ? resolveEntitlement(session.user.id) : null;

  const plans: PlanView[] = PLAN_LIST.map(plan => ({
    id: plan.id,
    name: plan.name,
    tagline: plan.tagline,
    priceUsd: plan.priceUsd,
    novelLimit: plan.novelLimit,
    features: plan.features,
    recommended: plan.recommended,
    purchasable: planPriceId(plan.id) !== null,
  }));

  const anyPurchasable = plans.some(p => p.purchasable);

  return (
    <div className="min-h-screen bg-[#05070D]">
      <header className="border-b border-white/5">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          <Link href={signedIn ? '/dashboard' : '/'} className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-900/40">
              <span className="font-serif font-bold text-white">NF</span>
            </div>
            <div>
              <div className="font-serif text-base font-semibold leading-tight">NovelForge</div>
              <div className="text-[9px] font-mono tracking-[0.18em] text-slate-400">WRITING STUDIO</div>
            </div>
          </Link>
          <div className="text-sm text-slate-400">
            {signedIn
              ? <Link href="/dashboard" className="hover:text-slate-200">Back to studio →</Link>
              : <><Link href="/login" className="hover:text-slate-200">Sign in</Link><span className="mx-3 text-slate-600">·</span><Link href="/register" className="text-indigo-400 hover:text-indigo-300 font-medium">Create an account</Link></>}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-16">
        <div className="text-center mb-14">
          <div className="label text-primary mb-3">PRICING</div>
          <h1 className="font-serif text-4xl md:text-5xl font-semibold mb-4">Pay for the studio, not per word.</h1>
          <p className="text-slate-400 max-w-2xl mx-auto">
            Novel creation needs an active plan. One chapter at a time, your Story Bible remembered, and every
            export format included — no per-word metering and no lock-in on your manuscript.
          </p>
          {entitlement?.freeAccess && (
            <p className="mt-6 inline-flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300">
              <ShieldCheck className="w-4 h-4" />
              Your account has free novel creation ({entitlement.freeAccessSource === 'admin' ? 'administrator' : 'granted by an administrator'}).
            </p>
          )}
          {!anyPurchasable && (
            <p className="mt-6 inline-flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-300">
              <Lock className="w-4 h-4" />
              Billing is not connected on this deployment yet (Stripe price ids are unset) — see docs/billing.md.
            </p>
          )}
        </div>

        <PricingPlans
          plans={plans}
          signedIn={signedIn}
          currentPlan={entitlement?.plan ?? null}
          freeAccess={!!entitlement?.freeAccess}
        />

        <div className="grid md:grid-cols-3 gap-6 max-w-4xl mx-auto mt-16 text-sm">
          <Note icon={<BookOpen className="w-4 h-4 text-indigo-400" />} title="Your manuscript is yours">
            Cancel whenever you like and export your novels in every format before you go. No lock-in on your words.
          </Note>
          <Note icon={<ShieldCheck className="w-4 h-4 text-emerald-400" />} title="Payments by Stripe">
            Card details are collected by Stripe Checkout and never touch NovelForge servers. Manage or cancel from the
            billing portal in Settings.
          </Note>
          <Note icon={<Undo2 className="w-4 h-4 text-fuchsia-400" />} title="Admins can comp accounts">
            Administrators can grant free novel creation to any account from the admin console — useful for beta
            readers, staff and collaborators.
          </Note>
        </div>

        <p className="text-center text-xs text-slate-500 mt-12">
          Prices are shown in USD and configured in your Stripe account. Taxes and local currency are handled by Stripe
          at checkout.
        </p>
      </main>
    </div>
  );
}

function Note({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="surface p-5">
      <div className="flex items-center gap-2 mb-2 font-medium">{icon}{title}</div>
      <p className="text-slate-400 text-xs leading-relaxed">{children}</p>
    </div>
  );
}
