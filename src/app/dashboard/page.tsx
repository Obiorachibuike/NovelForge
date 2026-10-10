import { auth } from '@/lib/auth/config';
import { listNovels } from '@/services/novels/service';
import { NovelCard } from '@/components/dashboard/NovelCard';
import Link from 'next/link';
import { BookOpen, PlusCircle, Sparkles, BookCheck, PenTool, CheckCircle2 } from 'lucide-react';
export default async function Dashboard() {
  const session = (await auth()) as any;
  if (!session?.user) { const { redirect } = await import('next/navigation'); redirect('/login'); }
  const novels = await listNovels(session.user.id);
  const inProgress = novels.filter(n => n.status !== 'completed').slice(0,6);
  const completed = novels.filter(n => n.status === 'completed').slice(0,3);
  const totalWords = novels.reduce((s,n)=>s+n.wordsWritten,0);
  const totalApproved = novels.reduce((s,n)=>s+n.chaptersCompleted,0);
  return <div className="flex-1 overflow-y-auto"><div className="max-w-7xl mx-auto px-8 py-10">
    <header className="mb-10 flex items-end justify-between flex-wrap gap-4">
      <div><div className="label text-primary mb-2">GOOD TO SEE YOU</div>
        <h1 className="font-serif text-4xl font-semibold">Welcome back, {session.user.name?.split(' ')[0] || 'Writer'}.</h1>
        <p className="text-muted-foreground mt-2 max-w-xl">Your studio is ready. Every word you approve becomes part of something that remembers.</p>
      </div>
      <Link href="/novels/new" className="btn-primary"><PlusCircle className="w-4 h-4"/> New novel</Link>
    </header>
    <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
      <Stat label="Novels" value={novels.length} Icon={BookOpen}/>
      <Stat label="Words approved" value={totalWords.toLocaleString()} Icon={PenTool}/>
      <Stat label="Chapters approved" value={totalApproved} Icon={CheckCircle2}/>
      <Stat label="Completed novels" value={completed.length} Icon={BookCheck}/>
    </section>
    <section className="mb-12">
      <div className="flex items-end justify-between mb-5">
        <h2 className="font-serif text-2xl font-semibold">In progress</h2>
        <Link href="/novels/new" className="text-primary text-sm font-medium hover:underline">Start another →</Link>
      </div>
      {inProgress.length===0 ? <div className="surface p-14 text-center">
        <Sparkles className="w-10 h-10 text-primary/60 mx-auto mb-4"/>
        <h3 className="font-serif text-xl mb-2">Begin with a spark</h3>
        <p className="text-muted-foreground text-sm max-w-md mx-auto mb-6">Start a new novel to generate covers, prepare your Story Bible, and write your first chapter.</p>
        <Link href="/novels/new" className="btn-primary"><PlusCircle className="w-4 h-4"/> Create your first novel</Link>
      </div> : <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">{inProgress.map(n=><NovelCard key={n.id} novel={n}/>)}</div>}
    </section>
    {completed.length>0 && <section><h2 className="font-serif text-2xl font-semibold mb-5">Completed</h2><div className="grid md:grid-cols-3 gap-5">{completed.map(n=><NovelCard key={n.id} novel={n}/>)}</div></section>}
  </div></div>;
}
function Stat({label,value,Icon}){return <div className="surface p-5 card-hover"><div className="flex items-start justify-between mb-3"><span className="label">{label}</span><Icon className="w-4 h-4 text-muted-foreground"/></div><div className="font-serif text-3xl font-semibold">{value}</div></div>;}
