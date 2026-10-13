'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search, Loader2, ShieldCheck, Unlock, Lock, Crown, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface AdminUser {
  id: string;
  name: string | null;
  email: string | null;
  role: 'user' | 'admin';
  freeNovelAccess: boolean;
  freeNovelGrantedBy: string | null;
  freeNovelGrantedAt: string | null;
  novelsInProgress: number;
  plan: string | null;
  status: string | null;
  canCreateNovel: boolean;
  reason: string;
}

interface AuditEntry {
  id: string;
  actorId: string;
  targetUserId: string | null;
  action: string;
  details: string | null;
  createdAt: string;
}

/**
 * Admin console: make an account an administrator, or grant free novel
 * creation without a subscription. Every change goes through the admin API and
 * is recorded in the audit log below the table.
 */
export default function AdminUsers({ initialUsers, initialAudit }: { initialUsers: AdminUser[]; initialAudit: AuditEntry[] }) {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);

  const { data, isFetching } = useQuery({
    queryKey: ['admin-users', query],
    queryFn: async () => {
      const res = await fetch(`/api/admin/users?q=${encodeURIComponent(query)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load users');
      return res.json() as Promise<{ users: AdminUser[]; audit: AuditEntry[] }>;
    },
    initialData: { users: initialUsers, audit: initialAudit },
    refetchOnWindowFocus: false,
  });

  const users = data?.users ?? initialUsers;

  async function patch(user: AdminUser, body: { role?: 'user' | 'admin'; freeNovelAccess?: boolean }) {
    setPending(user.id);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Could not update this account.');
        return;
      }
      if (body.freeNovelAccess !== undefined) {
        toast.success(body.freeNovelAccess ? `Free novel creation granted to ${user.email}.` : `Free novel creation revoked from ${user.email}.`);
      }
      if (body.role !== undefined) {
        toast.success(body.role === 'admin' ? `${user.email} is now an administrator.` : `${user.email} is no longer an administrator.`);
      }
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="surface p-4 flex items-center gap-3">
        <Search className="w-4 h-4 text-muted-foreground" />
        <input
          className="input flex-1"
          placeholder="Search by email or name"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {isFetching && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
      </div>

      <div className="surface overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left label border-b border-border">
              <th className="px-4 py-3">Account</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Novels</th>
              <th className="px-4 py-3">Can create</th>
              <th className="px-4 py-3 text-right">Privileges</th>
            </tr>
          </thead>
          <tbody>
            {users.map(user => (
              <tr key={user.id} className="border-b border-border/50 last:border-0 align-top">
                <td className="px-4 py-3">
                  <div className="font-medium">{user.name || '—'}</div>
                  <div className="text-muted-foreground text-xs">{user.email}</div>
                  {user.role === 'admin' && <span className="chip chip-primary mt-1 inline-flex items-center gap-1"><Crown className="w-3 h-3" /> admin</span>}
                  {user.freeNovelAccess && <span className="chip chip-success mt-1 ml-1 inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> free access</span>}
                </td>
                <td className="px-4 py-3">
                  {user.plan ? (
                    <>
                      <div className="capitalize">{user.plan}</div>
                      <div className="text-xs text-muted-foreground">{user.status || '—'}</div>
                    </>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-4 py-3">{user.novelsInProgress}</td>
                <td className="px-4 py-3">
                  <span className={cn('chip', user.canCreateNovel ? 'chip-success' : 'chip-error')}>
                    {user.canCreateNovel ? 'yes' : 'no'}
                  </span>
                  <div className="text-[11px] text-muted-foreground mt-1">{user.reason}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-2 justify-end">
                    <button
                      className="btn-outline text-xs"
                      disabled={pending === user.id}
                      onClick={() => patch(user, { freeNovelAccess: !user.freeNovelAccess })}
                    >
                      {pending === user.id
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : user.freeNovelAccess ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                      {user.freeNovelAccess ? 'Revoke free access' : 'Grant free access'}
                    </button>
                    <button
                      className="btn-outline text-xs"
                      disabled={pending === user.id}
                      onClick={() => patch(user, { role: user.role === 'admin' ? 'user' : 'admin' })}
                    >
                      <Sparkles className="w-3 h-3" />
                      {user.role === 'admin' ? 'Remove admin' : 'Make admin'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">No accounts match that search.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="surface p-5">
        <h2 className="font-serif text-lg font-semibold mb-3">Recent privilege changes</h2>
        {(data?.audit ?? initialAudit).length === 0
          ? <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
          : (
            <ul className="space-y-2 text-sm">
              {(data?.audit ?? initialAudit).map(entry => (
                <li key={entry.id} className="flex items-start justify-between gap-4 border-b border-border/50 last:border-0 pb-2">
                  <div>
                    <div className="font-medium">{entry.action.replace(/_/g, ' ')}</div>
                    <div className="text-xs text-muted-foreground">
                      target {entry.targetUserId ?? '—'} · by {entry.actorId}
                      {entry.details ? ` · ${entry.details}` : ''}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap">{new Date(entry.createdAt).toLocaleString()}</div>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  );
}
