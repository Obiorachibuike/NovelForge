'use client';
import { useState } from 'react';
import { signIn } from 'next-auth/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { BookOpen, Loader2 } from 'lucide-react';

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const res = await signIn('credentials', { name, email, password, action: 'register', redirect: false });
    setLoading(false);
    if (res?.error) { toast.error(res.error); return; }
    toast.success('Welcome to NovelForge');
    router.push('/dashboard');
  }

  return (
    <div className="min-h-screen bg-[#05070D] grid lg:grid-cols-2">
      <div className="flex items-center justify-center p-8 order-2 lg:order-1">
        <form onSubmit={onSubmit} className="w-full max-w-md space-y-5">
          <div>
            <div className="lg:hidden flex items-center gap-3 mb-8">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-900/50">
                <span className="font-serif text-lg font-bold">NF</span>
              </div>
              <div className="font-serif text-xl font-semibold">NovelForge</div>
            </div>
            <h1 className="font-serif text-3xl font-semibold mb-2">Create your studio</h1>
            <p className="text-sm text-slate-400">Begin with a title. Write a world.</p>
          </div>
          <div>
            <label className="label block mb-2">Name</label>
            <input className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="Your pen name or given name" required />
          </div>
          <div>
            <label className="label block mb-2">Email</label>
            <input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" required />
          </div>
          <div>
            <label className="label block mb-2">Password</label>
            <input className="input" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8} />
          </div>
          <button className="btn-primary w-full" disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookOpen className="w-4 h-4" />} Create my account
          </button>
          <div className="text-center text-sm text-slate-400">
            Already have an account? <Link className="text-indigo-400 hover:text-indigo-300 font-medium" href="/login">Sign in</Link>
          </div>
        </form>
      </div>
      <div className="hidden lg:flex flex-col justify-between p-12 bg-gradient-to-br from-violet-950/40 to-fuchsia-950/30 border-l border-white/5 relative overflow-hidden order-1 lg:order-2">
        <div className="absolute -bottom-20 -right-20 w-[500px] h-[500px] bg-violet-500/20 rounded-full blur-3xl" />
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-900/50">
            <span className="font-serif text-lg font-bold">NF</span>
          </div>
          <div>
            <div className="font-serif text-xl font-semibold">NovelForge</div>
            <div className="text-[10px] font-mono tracking-widest text-slate-400">WRITING STUDIO</div>
          </div>
        </div>
        <div className="relative z-10 space-y-6">
          <h2 className="font-serif text-4xl leading-tight font-semibold">Every story begins with a single word. We help you write the ones that follow.</h2>
          <ul className="space-y-3 text-sm text-slate-300">
            {['AI-assisted, never AI-controlled','Sequential chapter approval','Persistent Story Bible memory','Export to DOCX, PDF, EPUB, TXT, MD'].map(f=>(
              <li key={f} className="flex items-start gap-2"><span className="text-emerald-400 mt-0.5">✓</span>{f}</li>
            ))}
          </ul>
        </div>
        <div className="relative z-10 text-xs text-slate-500">No credit card required. Works with or without an AI API key.</div>
      </div>
    </div>
  );
}
