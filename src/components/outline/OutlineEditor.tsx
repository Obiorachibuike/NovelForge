'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Wand2, CheckCircle2, Lock, ArrowRight, RefreshCw, BookOpen, Play, Pencil, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useJobWatcher } from '@/lib/hooks/useJobWatcher';

export default function OutlineEditor({ novel, outlines, acts, chapters, navigation }: any) {
  const router = useRouter();
  const qc = useQueryClient();
  const [structure, setStructure] = useState('three-act');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ title: string; summary: string; targetWords: number }>({
    title: '',
    summary: '',
    targetWords: 2500,
  });
  const hasOutline = outlines.length > 0;

  const { job: outlineJob, watch } = useJobWatcher({
    onComplete: () => {
      toast.success('Outline generated.');
      qc.invalidateQueries();
      router.refresh();
    },
    onFail: (job) => toast.error(`Outline generation failed: ${job.error || 'unknown error'}`),
  });
  const isGeneratingOutline = outlineJob?.status === 'queued' || outlineJob?.status === 'processing';

  const gen = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/novels/${novel.id}/outline`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ structure }) });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      return res.json();
    },
    onSuccess: (data: any) => {
      if (data?.jobId) {
        toast.message('Generating chapter outline…');
        watch(data.jobId);
      } else {
        toast.success('Outline generated.');
        qc.invalidateQueries();
        router.refresh();
      }
    },
    onError: (e:any) => toast.error(e.message),
  });

  const patchOutlineMut = useMutation({
    mutationFn: async ({ outlineId, patch }: { outlineId: string; patch: { title: string; summary: string; targetWords: number } }) => {
      const res = await fetch(`/api/novels/${novel.id}/outline/${outlineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to update outline');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Chapter plan updated.');
      setEditingId(null);
      qc.invalidateQueries();
      router.refresh();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const approve = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/novels/${novel.id}/approve-outline`, { method:'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      return res.json();
    },
    onSuccess: () => { toast.success('Outline approved — Chapter 1 is ready to write.'); router.push(`/novels/${novel.id}/write/1`); },
    onError: (e:any) => toast.error(e.message),
  });

  const plannedWords = outlines.reduce((s:number,c:any)=>s+c.targetWords,0);
  const approvedChapters = chapters.filter((c:any)=>c.status==='approved').length;

  // Statuses come from the server-side workflow gate so this list can never
  // disagree with the writing workspace about which chapter is unlocked.
  const enriched = (navigation && navigation.length)
    ? navigation.map((n: any) => {
        const outlineRow = outlines.find((o: any) => o.chapterNumber === n.chapterNumber);
        return {
          ...outlineRow,
          ...n,
          id: outlineRow?.id || `ch-${n.chapterNumber}`,
          estimatedPages: n.targetPages ?? outlineRow?.estimatedPages ?? Math.max(1, Math.round((n.targetWords || 2500) / 320)),
          chapterId: n.chapterId,
        };
      })
    : outlines.map((o: any) => {
        const chapter = chapters.find((c: any) => c.chapterNumber === o.chapterNumber);
        return { ...o, chapterId: chapter?.id, status: chapter?.status || 'planned', wordCount: chapter?.wordCount || 0 };
      });

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="label text-primary mb-2">STAGE {hasOutline ? '5' : '4'} · {hasOutline ? 'CHAPTER OUTLINE' : 'STRUCTURE'}</div>
          <h1 className="font-serif text-3xl font-semibold">{hasOutline ? 'A map with room for discovery.' : 'Shape the arc.'}</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">{hasOutline ? `${outlines.length} chapters · ${plannedWords.toLocaleString()} planned words · ~${Math.round(plannedWords/320)} estimated pages` : 'Choose a structure and generate a chapter-by-chapter outline.'}</p>
        </div>
        {hasOutline ? (
          <button className="btn-primary" disabled={approve.isPending || isGeneratingOutline} onClick={()=>approve.mutate()}>
            {approve.isPending ? <Loader2 className="w-4 h-4 animate-spin"/> : <CheckCircle2 className="w-4 h-4"/>} Approve & start writing
          </button>
        ) : (
          <div className="flex gap-2">
            <select className="input w-52" value={structure} onChange={e=>setStructure(e.target.value)}>
              <option value="three-act">Three-act structure</option>
              <option value="five-act">Five-act structure</option>
              <option value="heros-journey">Hero&apos;s Journey</option>
              <option value="custom">Custom</option>
            </select>
            <button className="btn-primary" onClick={()=>gen.mutate()} disabled={gen.isPending || isGeneratingOutline}>
              {(gen.isPending || isGeneratingOutline) ? <Loader2 className="w-4 h-4 animate-spin"/> : <Wand2 className="w-4 h-4"/>} {isGeneratingOutline ? 'Generating…' : 'Generate outline'}
            </button>
          </div>
        )}
      </div>

      {hasOutline && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <MiniStat label="Planned words" value={plannedWords.toLocaleString()} />
          <MiniStat label="Estimated pages" value={Math.round(plannedWords/320).toString()} />
          <MiniStat label="Avg / chapter" value={Math.round(plannedWords/Math.max(1,outlines.length)).toLocaleString()} />
          <MiniStat label="Approved chapters" value={`${approvedChapters} / ${outlines.length}`} />
        </div>
      )}

      {acts.length > 0 && (
        <div className="grid md:grid-cols-3 gap-3 mb-6">
          {acts.map((a:any)=>(
            <div key={a.id} className="surface p-4">
              <div className="text-[10px] font-mono tracking-widest text-muted-foreground mb-1">ACT {a.actNumber}</div>
              <div className="font-serif text-base font-semibold mb-1">{a.name}</div>
              {a.description && <p className="text-xs text-muted-foreground">{a.description}</p>}
              {a.turningPoint && <p className="text-xs text-primary mt-2 italic">Turning point: {a.turningPoint}</p>}
            </div>
          ))}
        </div>
      )}

      {hasOutline ? (
        <div className="surface divide-y divide-border overflow-hidden">
          {enriched.map((c:any)=>(
            <div key={c.id || c.chapterNumber} className={cn('flex items-center gap-4 p-4 transition',
              c.status==='locked' && 'opacity-50',
              c.status==='approved' && 'bg-emerald-500/5'
            )}>
              <span className="text-muted-foreground font-mono text-xs w-8">{String(c.chapterNumber).padStart(2,'0')}</span>
              {editingId === c.id ? (
                <div className="flex-1 grid md:grid-cols-[1fr_120px_auto] gap-2 items-center">
                  <div className="space-y-1.5">
                    <input
                      className="input text-sm py-1"
                      value={editDraft.title}
                      onChange={e => setEditDraft({ ...editDraft, title: e.target.value })}
                      placeholder="Chapter title"
                    />
                    <input
                      className="input text-xs py-1"
                      value={editDraft.summary}
                      onChange={e => setEditDraft({ ...editDraft, summary: e.target.value })}
                      placeholder="Chapter summary"
                    />
                  </div>
                  <input
                    type="number"
                    className="input text-xs py-1"
                    min={250}
                    max={20000}
                    value={editDraft.targetWords}
                    onChange={e => setEditDraft({ ...editDraft, targetWords: Number(e.target.value) || 2500 })}
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="btn-primary text-xs px-2.5 py-1"
                      disabled={patchOutlineMut.isPending}
                      onClick={() => patchOutlineMut.mutate({ outlineId: c.id, patch: editDraft })}
                    >
                      <Check className="w-3.5 h-3.5" /> Save
                    </button>
                    <button
                      type="button"
                      className="btn-outline text-xs px-2 py-1"
                      onClick={() => setEditingId(null)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-serif text-base font-semibold">{c.title}</h3>
                      <StatusChip status={c.status} />
                    </div>
                    {c.summary && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{c.summary}</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-serif text-base">{c.targetWords.toLocaleString()}</div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{c.estimatedPages} pg</div>
                  </div>
                  {c.status !== 'approved' && c.id && !String(c.id).startsWith('ch-') && (
                    <button
                      type="button"
                      className="p-1.5 text-muted-foreground hover:text-foreground"
                      title="Edit chapter plan"
                      onClick={() => {
                        setEditingId(c.id);
                        setEditDraft({ title: c.title || '', summary: c.summary || '', targetWords: c.targetWords || 2500 });
                      }}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {c.status === 'locked' ? (
                    <Lock className="w-4 h-4 text-muted-foreground" />
                  ) : c.status === 'approved' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : c.chapterId ? (
                    <button className="btn-outline text-xs px-3 py-1.5" onClick={()=>router.push(`/novels/${novel.id}/write/${c.chapterNumber}`)}>
                      <Play className="w-3 h-3"/> Open
                    </button>
                  ) : (
                    <button className="btn-primary text-xs px-3 py-1.5" disabled={c.status === 'locked'} onClick={()=>router.push(`/novels/${novel.id}/write/${c.chapterNumber}`)}>
                      Write <ArrowRight className="w-3 h-3"/>
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="surface p-14 text-center">
          <BookOpen className="w-10 h-10 text-primary/60 mx-auto mb-4" />
          <h3 className="font-serif text-xl mb-2">Structure awaits</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto mb-6">Generate a chapter-by-chapter outline. You can edit every chapter before approving the plan.</p>
        </div>
      )}

      {hasOutline && (
        <div className="flex justify-between mt-6">
          <button className="btn-outline" onClick={()=>gen.mutate()} disabled={gen.isPending || isGeneratingOutline}>
            <RefreshCw className={cn('w-4 h-4', (gen.isPending || isGeneratingOutline) && 'animate-spin')}/> Regenerate outline
          </button>
          <button className="btn-primary" onClick={()=>approve.mutate()} disabled={approve.isPending || isGeneratingOutline}>
            Approve & start writing <ArrowRight className="w-4 h-4"/>
          </button>
        </div>
      )}
    </div>
  );
}

function MiniStat({label,value}:{label:string;value:string}){return <div className="surface p-4"><div className="label mb-1">{label}</div><div className="font-serif text-2xl font-semibold">{value}</div></div>;}
function StatusChip({status}:{status:string}){
  const map: Record<string,string> = { planned:'chip-muted', writing:'chip-primary', generated:'chip-warning', edited:'chip-warning', approved:'chip-success', locked:'chip-muted' };
  return <span className={`chip ${map[status]||'chip-muted'}`}>{status}</span>;
}
