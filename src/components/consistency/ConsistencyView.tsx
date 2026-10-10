'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { Loader2, Play, CheckCircle, AlertTriangle, Info, XCircle, ArrowRight, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export default function ConsistencyView({ novel, score, issues, chapterCount, approvedCount, issueCount }: any) {
  const router = useRouter();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/novels/${novel.id}/consistency`, { method:'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      return res.json();
    },
    onSuccess: () => { toast.success('Consistency check queued'); setTimeout(()=>{qc.invalidateQueries(); router.refresh();}, 1500); },
    onError: (e:any)=>toast.error(e.message),
  });
  const resolve = useMutation({
    mutationFn: async ({ issueId, status }: { issueId:string; status:'resolved'|'ignored' }) => {
      const res = await fetch(`/api/novels/${novel.id}/consistency`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ issueId, status }) });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      return res.json();
    },
    onSuccess: () => { toast.success('Issue updated'); qc.invalidateQueries(); router.refresh(); },
    onError: (e:any)=>toast.error(e.message),
  });
  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-8 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="label text-primary mb-2">STAGE 8 · CONSISTENCY</div>
          <h1 className="font-serif text-3xl font-semibold">Keep every detail true.</h1>
          <p className="text-muted-foreground mt-2 max-w-xl">The consistency engine checks your manuscript against the Story Bible for timeline clashes, world-rule violations, and forgotten threads.</p>
        </div>
        <button className="btn-primary" onClick={()=>run.mutate()} disabled={run.isPending}>
          {run.isPending ? <Loader2 className="w-4 h-4 animate-spin"/> : <Play className="w-4 h-4"/>} Run check
        </button>
      </div>

      <div className="surface p-8 mb-6 flex items-center gap-8 flex-wrap">
        <div className="relative w-28 h-28 rounded-full flex items-center justify-center" style={{background:`conic-gradient(hsl(var(--primary)) ${score}%, hsl(var(--surface-secondary)) ${score}% 100%)`}}>
          <div className="absolute inset-2 rounded-full bg-[hsl(var(--surface))] flex flex-col items-center justify-center">
            <div className="font-serif text-3xl font-semibold">{score}</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">/100</div>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <span className={cn('chip', score>=90?'chip-success':score>=70?'chip-warning':'chip-error')}>
            {score>=90?'HEALTHY':score>=70?'NEEDS REVIEW':'ATTENTION'}
          </span>
          <h2 className="font-serif text-2xl mt-2">
            {score>=90 ? 'Your story is holding together.' : score>=70 ? 'A few things need attention.' : 'Several issues should be addressed.'}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {approvedCount} of {chapterCount} chapters approved · {issueCount} open issue{issueCount===1?'':'s'}.
          </p>
        </div>
        <button className="btn-outline" onClick={()=>router.push(`/novels/${novel.id}/export`)}>
          Continue to export <ArrowRight className="w-4 h-4"/>
        </button>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-serif text-lg font-semibold">Needs your attention</h3>
          <span className="chip chip-muted">{issues.filter((i:any)=>i.status==='open').length} open</span>
        </div>
        {issues.length === 0 ? (
          <div className="surface p-10 text-center">
            <CheckCircle className="w-10 h-10 text-emerald-400/60 mx-auto mb-4"/>
            <p className="text-sm text-muted-foreground">No issues found. Run a check after approving chapters.</p>
          </div>
        ) : issues.map((i:any)=>(
          <div key={i.id} className={cn('surface p-4 flex items-start gap-3', i.status!=='open' && 'opacity-60')}>
            <IssueIcon severity={i.severity} kind={i.kind} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <b className="text-sm">{i.title}</b>
                <span className={cn('chip', i.severity==='error'?'chip-error':i.severity==='warning'?'chip-warning':'chip-muted')}>{i.severity}</span>
                <span className="chip chip-muted">{i.kind}</span>
                {i.chapterTitle && <span className="text-xs text-muted-foreground">· Chapter {i.chapterNumber}: {i.chapterTitle}</span>}
                {i.status !== 'open' && <span className="chip chip-success">{i.status}</span>}
              </div>
              <p className="text-sm text-muted-foreground mt-1">{i.description}</p>
              {i.evidence && <p className="text-xs text-muted-foreground/80 mt-1 italic">"{i.evidence.slice(0,200)}"</p>}
              {i.suggestion && <p className="text-xs text-primary mt-1"><b>Suggestion:</b> {i.suggestion}</p>}
            </div>
            {i.status==='open' && (
              <div className="flex flex-col gap-1">
                <button onClick={()=>resolve.mutate({issueId:i.id,status:'resolved'})} className="btn-outline text-xs px-2 py-1">Resolve</button>
                <button onClick={()=>resolve.mutate({issueId:i.id,status:'ignored'})} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1">Ignore</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function IssueIcon({ severity, kind }: { severity:string; kind:string }) {
  const Icon = severity==='error' ? XCircle : severity==='warning' ? AlertTriangle : Info;
  const color = severity==='error' ? 'text-destructive bg-destructive/10' : severity==='warning' ? 'text-amber-400 bg-amber-500/10' : 'text-primary bg-primary/10';
  return <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${color}`}><Icon className="w-4 h-4"/></div>;
}
