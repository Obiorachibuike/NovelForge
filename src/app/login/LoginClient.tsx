'use client';
import { useState, Suspense } from 'react';
import { signIn } from 'next-auth/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { BookOpen, Loader2 } from 'lucide-react';
import GoogleSignInButton from '@/components/auth/GoogleSignInButton';

/** NextAuth redirects back with `?error=<code>`; translate the ones users hit. */
const OAUTH_ERRORS: Record<string, string> = {
  AccessDenied:
    'That Google account could not be linked. If you signed up with a password, sign in with it first.',
  OAuthAccountNotLinked:
    'That Google account is already linked to a different NovelForge account.',
  OAuthSignin: 'Google sign-in could not be started. Please try again.',
  OAuthCallback: 'Google sign-in did not complete. Please try again.',
  OAuthCreateAccount: 'A NovelForge account could not be created for that Google account.',
  Configuration:
    'Google sign-in is not configured correctly on this deployment (check AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET).',
  Verification: 'That sign-in link has expired or was already used.',
};

function LoginForm({ googleEnabled }: { googleEnabled: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const authError = params.get('error');
  const callbackUrl = params.get('callbackUrl') || '/dashboard';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true);
    const res = await signIn('credentials', { email, password, redirect: false });
    setLoading(false);
    if (res?.error) { toast.error('Those credentials were not accepted.'); return; }
    toast.success('Welcome back');
    router.push(callbackUrl);
  }

  return <form onSubmit={onSubmit} className="w-full max-w-md space-y-5">
    <div>
      <div className="lg:hidden flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-900/50"><span className="font-serif text-lg font-bold">NF</span></div>
        <div className="font-serif text-xl font-semibold">NovelForge</div>
      </div>
      <h1 className="font-serif text-3xl font-semibold mb-2">Welcome back</h1>
      <p className="text-sm text-slate-400">Sign in to return to your novels.</p>
    </div>

    {authError && (
      <p role="alert" className="text-xs text-amber-400 text-center">
        {OAUTH_ERRORS[authError] || 'Sign-in could not be completed. Please try again.'}
      </p>
    )}

    {googleEnabled && (
      <>
        <GoogleSignInButton callbackUrl={callbackUrl} />
        <div className="flex items-center gap-3 text-[11px] uppercase tracking-widest text-slate-500">
          <span className="h-px flex-1 bg-white/10" /> or <span className="h-px flex-1 bg-white/10" />
        </div>
      </>
    )}

    <div><label className="label block mb-2" htmlFor="login-email">Email</label>
      <input id="login-email" className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required />
    </div>
    <div><label className="label block mb-2" htmlFor="login-password">Password</label>
      <input id="login-password" className="input" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" required minLength={8} />
    </div>
    <button className="btn-primary w-full" disabled={loading}>{loading?<Loader2 className="w-4 h-4 animate-spin"/>:<BookOpen className="w-4 h-4"/>}Sign in</button>
    <div className="text-center text-sm text-slate-400">New to NovelForge? <Link className="text-indigo-400 hover:text-indigo-300 font-medium" href="/register">Create an account</Link></div>
    {!googleEnabled && (
      <div className="text-center text-xs text-slate-500 pt-4 border-t border-white/5">Demo mode works out of the box — register with any email and password.</div>
    )}
  </form>;
}

export default function LoginClient({ googleEnabled = false }: { googleEnabled?: boolean }) {
  return <Suspense fallback={<div className="text-slate-400">Loading…</div>}><LoginForm googleEnabled={googleEnabled} /></Suspense>;
}
