import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/config';
import { resolveEntitlement } from '@/services/billing/service';
import NewNovelForm from '@/components/novel/NewNovelForm';
import Link from 'next/link';
import { Sparkles, Lock } from 'lucide-react';

export const dynamic = 'force-dynamic';

/**
 * Novel creation entry point.
 *
 * The API already refuses novel creation without an entitlement (402
 * `payment_required`); this page mirrors that decision so a writer sees the
 * reason and the plans instead of filling in a form that cannot be submitted.
 */
export default async function NewNovelPage() {
  const session = (await auth()) as any;
  if (!session?.user?.id) redirect('/login?callbackUrl=/novels/new');

  const entitlement = resolveEntitlement(session.user.id);
  if (entitlement.canCreateNovel) return <NewNovelForm />;

  const limitHint = Number.isFinite(entitlement.novelLimit)
    ? `${entitlement.novelLimit} novel${entitlement.novelLimit === 1 ? '' : 's'} in progress`
    : 'an active plan';

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-8 py-16 text-center">
        <div className="surface p-10">
          <Lock className="w-10 h-10 text-primary/70 mx-auto mb-5" />
          <div className="label text-primary mb-2">PLAN REQUIRED</div>
          <h1 className="font-serif text-3xl font-semibold mb-3">Novel creation needs a plan.</h1>
          <p className="text-muted-foreground mb-2">
            {entitlement.reason === 'novel_limit_reached'
              ? `You have reached the limit for your plan (${limitHint}). Finish or archive a novel to start another, or move to a larger plan.`
              : `Your account can create novels with ${limitHint}. An administrator can also grant free access.`}
          </p>
          {entitlement.novelsInProgress > 0 && (
            <p className="text-xs text-muted-foreground mb-2">{entitlement.novelsInProgress} novel(s) in progress on this account.</p>
          )}
          <div className="flex items-center justify-center gap-3 mt-7">
            <Link href="/pricing" className="btn-primary"><Sparkles className="w-4 h-4" /> See plans</Link>
            <Link href="/dashboard" className="btn-outline">Back to dashboard</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
