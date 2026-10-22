import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/config';
import { isAdmin } from '@/services/billing/service';
import ModelDashboard from '@/components/admin/ai/ModelDashboard';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'AI models · NovelForge' };

/**
 * Hosted-inference model management console.
 *
 * Server-gated on the admin role (every mutating API route checks it again), so
 * a non-administrator is redirected rather than shown controls that would 403.
 */
export default async function AdminAiPage() {
  const session = (await auth()) as any;
  if (!session?.user?.id) redirect('/login?callbackUrl=/admin/ai');
  if (!isAdmin(session.user.id)) redirect('/dashboard');

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-7xl mx-auto px-8 py-10">
        <header className="mb-8">
          <div className="label text-primary mb-2">ADMIN · AI INFRASTRUCTURE</div>
          <h1 className="font-serif text-3xl font-semibold">Hugging Face model management</h1>
          <p className="text-muted-foreground mt-2 max-w-3xl">
            NovelForge is configured with 50 text models and 20 text-to-image models. Configured does not mean operational:
            availability, hosted-provider support and pricing are reported only from real verification or a successful
            inference. Run verification (metadata first, smoke tests when you want proof) before relying on a model.
          </p>
        </header>
        <ModelDashboard />
      </div>
    </div>
  );
}
