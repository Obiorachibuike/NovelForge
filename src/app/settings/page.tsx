import { auth } from '@/lib/auth/config';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import SignOutButton from '@/components/auth/SignOutButton';
import { databaseStatus } from '@/lib/db';
import { queueInfo } from '@/lib/queue';
import { storageInfo } from '@/lib/storage';
import { getAiBudget } from '@/lib/ai/provider';
import { aiPolicy } from '@/lib/ai/config';
import { usageSummary } from '@/lib/ai/usage';
import { listLinkedProviders, emailVerificationStatus } from '@/services/auth/service';
import { entitlementSummary, resolveEntitlement } from '@/services/billing/service';
import BillingCard from '@/components/billing/BillingCard';
import { stripeConfigured, webhookConfigured } from '@/lib/billing/stripe';
import { billingCatalogReady } from '@/lib/billing/plans';

/**
 * Reports what the running code actually does. Earlier versions printed
 * "PostgreSQL"/"Cloudinary"/"Redis / BullMQ" whenever an environment variable
 * was present, even though those adapters were not implemented.
 */
export default async function SettingsPage() {
  const session = await auth();
  const db = (() => { try { return databaseStatus(); } catch (err) { return { driver: 'error', message: err instanceof Error ? err.message : String(err) }; } })();
  const storage = await storageInfo();
  const queue = queueInfo();
  const budget = getAiBudget();
  const ai = aiPolicy();
  const aiStatus = ai.backend === 'huggingface'
    ? `Hugging Face · ${ai.defaultTextModel}`
    : ai.backend === 'openai'
      ? `OpenAI · ${process.env.OPENAI_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini'}`
      : 'Demo mode — configure HF_TOKEN (Hugging Face) or OPENAI_API_KEY';
  const usage = session?.user?.id ? usageSummary(session.user.id, 24) : null;
  const linkedProviders = session?.user?.id ? listLinkedProviders(session.user.id) : [];
  // Read fresh from the database so the warning vanishes the moment the
  // verification completes, without waiting for the session JWT to rotate.
  const emailVerified = session?.user?.id ? emailVerificationStatus(session.user.id) : true;
  const verifyHref = session?.user?.email
    ? `/verify-email?email=${encodeURIComponent(session.user.email)}&callbackUrl=${encodeURIComponent('/settings')}`
    : '/verify-email';
  const entitlement = session?.user?.id ? resolveEntitlement(session.user.id) : null;
  const billingSummary = session?.user?.id ? entitlementSummary(session.user.id) : null;

  return <div className="p-8 max-w-3xl mx-auto w-full">
    <div className="mb-8"><div className="label text-primary mb-2">SETTINGS</div><h1 className="font-serif text-3xl font-semibold">Your studio</h1></div>
    <div className="space-y-4">
      <div className="surface p-6 flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-gradient-to-br from-pink-400 to-indigo-400 flex items-center justify-center font-bold text-lg">{session?.user?.name?.[0]?.toUpperCase()||'U'}</div>
        <div className="flex-1">
          <div className="font-serif text-lg font-semibold">{session?.user?.name}</div>
          <div className="text-sm text-muted-foreground">{session?.user?.email}</div>
          <div className="mt-2 flex items-center gap-2">
            {Providers({ linked: linkedProviders })}
          </div>
          {!emailVerified && (
            <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                Your email address is not verified yet.{' '}
                <Link className="underline font-medium text-amber-100 hover:text-amber-50" href={verifyHref}>
                  Verify it now
                </Link>{' '}
                — this takes you to the verification process (the emailed link or the 6-digit code).
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="surface p-6">
        <h3 className="font-serif text-lg font-semibold mb-3">Runtime (what the code actually does)</h3>
        <div className="space-y-2 text-sm">
          <Row label="AI mode" value={aiStatus}/>
          <Row label="Storage" value={`${storage.provider}${storage.persistent ? ' · persistent' : ' · not persistent'}`}/>
          <Row label="Queue" value={queue.driver === 'redis' ? 'Redis (BullMQ) + database' : 'In-process + database'}/>
          <Row label="Database" value={'driver' in db && db.driver === 'error' ? 'Configuration error' : 'SQLite (single instance)'}/>
          <Row label="Billing" value={!stripeConfigured()
            ? 'Not configured — admins and comped accounts only'
            : billingCatalogReady()
              ? `Stripe connected${webhookConfigured() ? ' · webhook verified' : ' · webhook secret missing'}`
              : 'Stripe key set (plan price ids missing)'}/>
        </div>
        <p className="text-xs text-muted-foreground mt-3">{storage.note}</p>
        <p className="text-xs text-muted-foreground mt-1">{queue.note}</p>
      </div>
      {entitlement && billingSummary && (
        <BillingCard
          label={billingSummary.label}
          detail={billingSummary.detail}
          hasCustomer={entitlement.hasCustomer}
          canCreateNovel={entitlement.canCreateNovel}
          planName={entitlement.plan}
        />
      )}
      {usage && (
        <div className="surface p-6">
          <h3 className="font-serif text-lg font-semibold mb-3">AI usage · last 24h</h3>
          <div className="space-y-2 text-sm">
            <Row label="Requests" value={String(usage.requests)}/>
            <Row label="Tokens" value={`${usage.totalTokens.toLocaleString()} / ${budget.dailyTokenLimit.toLocaleString()} limit`}/>
            <Row label="Estimated cost" value={`$${usage.estimatedCostUsd.toFixed(4)}`}/>
          </div>
        </div>
      )}
      <SignOutButton />
    </div>
  </div>;
}
/** Which sign-in methods are attached to this account (accounts table). */
function Providers({ linked }: { linked: string[] }) {
  const hasPassword = true; // every credentials account has a password hash
  return <>
    {linked.includes('google')
      ? <span className="chip chip-success">Google linked</span>
      : <span className="chip">Google not linked</span>}
    {hasPassword && <span className="chip">Password</span>}
  </>;
}

function Row({label,value}:{label:string;value:string}){return <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0"><span className="text-muted-foreground text-xs uppercase tracking-wider">{label}</span><span className="font-medium">{value}</span></div>;}
