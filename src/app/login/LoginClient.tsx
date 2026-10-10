'use client';
import { useState, Suspense } from 'react';
import { signIn } from 'next-auth/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { BookOpen, Loader2 } from 'lucide-react';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true);
    const res = await signIn('credentials', { email, password, action: 'login', redirect: false });
    setLoading(false);
    if (res?.error) { toast.error(res.error); return; }
    toast.success('Welcome back');
    router.push(params.get('callbackUrl') || '/dashboard');
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
    <div><label className="label block mb-2">Email</label>
      <input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" required />
    </div>
    <div><label className="label block mb-2">Password</label>
      <input className="input" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" required minLength={8} />
    </div>
    <button className="btn-primary w-full" disabled={loading}>{loading?<Loader2 className="w-4 h-4 animate-spin"/>:<BookOpen className="w-4 h-4"/>}Sign in</button>
    <div className="text-center text-sm text-slate-400">New to NovelForge? <Link className="text-indigo-400 hover:text-indigo-300 font-medium" href="/register">Create an account</Link></div>
    <div className="text-center text-xs text-slate-500 pt-4 border-t border-white/5">Demo mode works out of the box — register with any email and password.</div>
  </form>;
}

export default function LoginClient() {
  return <Suspense fallback={<div className="text-slate-400">Loading…</div>}><LoginForm/></Suspense>;
}
