import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/config';
import { isAdmin, listUsersForAdmin, listAuditLog } from '@/services/billing/service';
import AdminUsers from '@/components/admin/AdminUsers';
import { Crown } from 'lucide-react';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · NovelForge' };

/**
 * Admin console.
 *
 * Gate-kept on the server (and again in every admin API route): a non-admin is
 * sent back to the dashboard rather than shown a page whose actions would 403.
 */
export default async function AdminPage() {
  const session = (await auth()) as any;
  if (!session?.user?.id) redirect('/login?callbackUrl=/admin');
  if (!isAdmin(session.user.id)) redirect('/dashboard');

  const users = listUsersForAdmin({ limit: 50 });
  const audit = listAuditLog(25);
  const admins = users.filter(u => u.role === 'admin').length;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-8 py-10">
        <header className="mb-8">
          <div className="label text-primary mb-2 flex items-center gap-2"><Crown className="w-3 h-3" /> ADMIN</div>
          <h1 className="font-serif text-3xl font-semibold">Accounts &amp; privileges</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            Administrators create novels for free. Use <strong>Grant free access</strong> to give a normal account the
            same privilege without a subscription — for collaborators, staff or beta readers. Every change is audited.
          </p>
          <p className="text-xs text-muted-foreground mt-3">
            {admins} administrator{admins === 1 ? '' : 's'} on this page · billing status comes from Stripe webhooks.
          </p>
        </header>
        <AdminUsers initialUsers={users} initialAudit={audit} />
      </div>
    </div>
  );
}
