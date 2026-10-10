import Link from 'next/link';
import { BookOpen, Sparkles, PenLine, Library, CheckCircle2, Upload, Brain, Eye } from 'lucide-react';
import { auth } from '@/lib/auth/config';
import { redirect } from 'next/navigation';

export default async function Landing() {
  const session = await auth();
  if (session?.user) redirect('/dashboard');

  return (
    <div className="min-h-screen bg-[#05070D] text-slate-100 relative overflow-hidden">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 -left-40 w-[600px] h-[600px] bg-indigo-600/20 rounded-full blur-3xl" />
        <div className="absolute top-40 right-0 w-[500px] h-[500px] bg-violet-600/15 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-1/2 w-[800px] h-[400px] bg-fuchsia-600/10 rounded-full blur-3xl" />
      </div>

      <header className="relative z-10 flex items-center justify-between px-8 py-6 max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-900/50">
            <span className="font-serif text-lg font-bold">NF</span>
          </div>
          <div>
            <div className="font-serif text-xl font-semibold">NovelForge</div>
            <div className="text-[10px] font-mono tracking-widest text-slate-400">WRITING STUDIO</div>
          </div>
        </div>
        <nav className="flex items-center gap-6 text-sm text-slate-400">
          <a href="#features" className="hover:text-white">Features</a>
          <a href="#workflow" className="hover:text-white">Workflow</a>
          <Link href="/login" className="text-slate-200 hover:text-white">Sign in</Link>
          <Link href="/register" className="btn-primary">Start writing →</Link>
        </nav>
      </header>

      <main className="relative z-10 max-w-7xl mx-auto px-8 pt-16 pb-28">
        <section className="text-center max-w-4xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs text-slate-300 mb-8">
            <Sparkles className="w-3 h-3 text-indigo-400" />
            AI-assisted, author-controlled
          </div>
          <h1 className="font-serif text-6xl md:text-7xl leading-[1.05] font-semibold mb-6">
            Build your story.
            <br />
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400 bg-clip-text text-transparent">Write your world.</span>
          </h1>
          <p className="text-slate-400 text-lg max-w-2xl mx-auto mb-10 leading-relaxed">
            NovelForge transforms a title into a complete novel through a carefully controlled workflow — from cover art
            to Story Bible, chapter outlines to finished pages. The AI prepares the novel. You control the story.
            NovelForge remembers everything that matters.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/register" className="btn-primary text-base px-6 py-3">
              <BookOpen className="w-4 h-4" /> Start your novel
            </Link>
            <a href="#workflow" className="btn-secondary text-base px-6 py-3">How it works</a>
          </div>
          <div className="mt-16 text-xs text-slate-500 tracking-widest font-mono">ONE CHAPTER AT A TIME · NEVER THE WHOLE BOOK</div>
        </section>

        <section id="features" className="grid md:grid-cols-3 gap-5 mt-28">
          {[
            { icon: BookOpen, title: 'Sequential writing', desc: 'Chapters are generated, edited, and approved one at a time. The next chapter stays locked until you say so.' },
            { icon: Brain, title: 'Persistent Story Bible', desc: 'Characters, locations, magic, timelines and plot threads are tracked in a structured database, not a lost prompt.' },
            { icon: Eye, title: 'Consistency engine', desc: 'Automatically detects timeline clashes, dead characters walking, world-rule violations, and forgotten threads.' },
            { icon: PenLine, title: 'Professional editor', desc: 'Rich Tiptap editor with autosave, version history, selection-based AI actions, and real-time word counts.' },
            { icon: Sparkles, title: 'Cover & art studio', desc: 'Generate book covers, portraits, and location art before you write a single word. Pick your primary, keep the rest.' },
            { icon: Upload, title: 'Export anywhere', desc: 'Export your manuscript as DOCX, PDF, EPUB, TXT, or Markdown with configurable fonts, margins, and front matter.' },
          ].map((f,i)=>(
            <div key={i} className="surface p-6 card-hover">
              <div className="w-10 h-10 rounded-lg bg-indigo-500/15 text-indigo-400 flex items-center justify-center mb-4">
                <f.icon className="w-5 h-5" />
              </div>
              <h3 className="font-serif text-xl font-semibold mb-2">{f.title}</h3>
              <p className="text-sm text-slate-400 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </section>

        <section id="workflow" className="mt-28">
          <div className="text-center mb-14">
            <div className="label mb-3 text-indigo-400">The Creation Path</div>
            <h2 className="font-serif text-4xl font-semibold">From first spark to final page</h2>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-5 gap-4">
            {[
              ['01','Title','A single seed of an idea.'],
              ['02','Cover','Visual concepts generated first.'],
              ['03','Bible','Characters, world, and premise.'],
              ['04','Outline','Acts, chapters, word budgets.'],
              ['05','Write','One chapter at a time — your call.'],
            ].map((s,i)=>(
              <div key={i} className="surface p-5 relative card-hover">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-mono mb-3 ${i===4?'bg-indigo-500 text-white shadow-lg shadow-indigo-900/40':'bg-white/5 text-slate-400'}`}>{s[0]}</div>
                <div className="font-serif font-semibold text-base">{s[1]}</div>
                <div className="text-xs text-slate-400 mt-1">{s[2]}</div>
              </div>
            ))}
          </div>
          <div className="mt-6 text-center text-sm text-slate-400">Then: Synchronize → Consistency checks → Export to DOCX, PDF, EPUB, and more.</div>
        </section>

        <section className="mt-28 surface p-10 md:p-14 text-center relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-600/10 to-violet-600/10 pointer-events-none" />
          <div className="relative">
            <h2 className="font-serif text-4xl font-semibold mb-4">Begin with a spark.</h2>
            <p className="text-slate-400 max-w-xl mx-auto mb-8">Start with a title — NovelForge prepares the foundation, but every word is yours to approve, rewrite, or replace.</p>
            <Link href="/register" className="btn-primary text-base px-8 py-3.5">
              <Library className="w-4 h-4" /> Open your studio
            </Link>
            <div className="mt-8 flex flex-wrap justify-center gap-6 text-xs text-slate-500">
              <span className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> You own every word</span>
              <span className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> No whole-book generation</span>
              <span className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Version history forever</span>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/5 py-8 text-center text-xs text-slate-500">
        NovelForge — The AI prepares the novel, the author controls the story.
      </footer>
    </div>
  );
}
