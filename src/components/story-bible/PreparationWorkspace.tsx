'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles, ArrowRight, Wand2, RefreshCw, User, MapPin, Scroll } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export default function PreparationWorkspace({ novel, premise, characters, worldRules }: any) {
  const router = useRouter();
  const qc = useQueryClient();
  const [activeSection, setActiveSection] = useState('logline');
  const hasContent = premise?.logline || characters.length;

  const prep = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/novels/${novel.id}/prepare`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({}) });
      if (!res.ok) throw new Error((await res.json()).error || 'Preparation failed');
      return res.json();
    },
    onSuccess: () => { toast.success('Premise, characters, and Story Bible generated.'); qc.invalidateQueries(); router.refresh(); },
    onError: (e:any) => toast.error(e.message),
  });

  const sections = [
    { key:'logline', label:'Logline', icon: Sparkles, value: premise?.logline, required:true },
    { key:'synopsis', label:'Synopsis', icon: Scroll, value: premise?.shortSynopsis, required:true },
    { key:'characters', label:'Characters', icon: User, value: characters.length ? `${characters.length} characters` : null, required:true },
    { key:'world', label:'World & rules', icon: MapPin, value: worldRules.length ? `${worldRules.length} rules` : null, required:true },
  ];

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="label text-primary mb-2">STAGE 3 · PREPARATION</div>
          <h1 className="font-serif text-3xl font-semibold">Shape the story before you write it.</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">Generate the premise, main characters, world rules, and timeline foundations that will guide every chapter.</p>
        </div>
        {hasContent && (
          <button className="btn-primary" onClick={()=>router.push(`/novels/${novel.id}/outline`)}>
            Build outline <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="grid lg:grid-cols-[320px_1fr] gap-6">
        <div className="space-y-2">
          {!hasContent ? (
            <div className="surface p-6 text-center">
              <Sparkles className="w-8 h-8 text-primary mx-auto mb-3" />
              <h3 className="font-serif text-lg font-semibold mb-2">Generate your foundation</h3>
              <p className="text-sm text-muted-foreground mb-4">The AI will produce a logline, synopsis, cast of characters, and world rules based on your title and premise.</p>
              <button onClick={()=>prep.mutate()} className="btn-primary w-full" disabled={prep.isPending}>
                {prep.isPending ? <><Loader2 className="w-4 h-4 animate-spin" /> Preparing...</> : <><Wand2 className="w-4 h-4" /> Generate Story Bible</>}
              </button>
              <p className="text-[11px] text-muted-foreground mt-3">You'll be able to edit and regenerate every section.</p>
            </div>
          ) : (
            <>
              {sections.map(s=>(
                <button key={s.key} onClick={()=>setActiveSection(s.key)} className={cn(
                  'w-full text-left p-4 rounded-lg border flex items-start gap-3 transition',
                  activeSection===s.key ? 'border-primary bg-primary/10' : 'border-border bg-[hsl(var(--surface))] hover:border-primary/40'
                )}>
                  <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', s.value ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/5 text-muted-foreground')}>
                    <s.icon className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-sm">{s.label}</div>
                      {s.value ? <span className="chip chip-success">Ready</span> : <span className="chip chip-warning">Empty</span>}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 truncate">{s.value || 'Not generated'}</div>
                  </div>
                </button>
              ))}
              <button onClick={()=>prep.mutate()} disabled={prep.isPending} className="w-full btn-outline mt-2">
                <RefreshCw className={cn('w-4 h-4', prep.isPending && 'animate-spin')} /> Regenerate all
              </button>
            </>
          )}
        </div>

        <div className="space-y-5">
          {hasContent ? (
            <>
              <SectionCard title="Logline" icon={Sparkles}>
                <p className="font-serif text-xl leading-relaxed">{premise?.logline}</p>
              </SectionCard>
              <SectionCard title="Short Synopsis" icon={Scroll}>
                <p className="text-sm leading-relaxed text-muted-foreground">{premise?.shortSynopsis}</p>
              </SectionCard>
              {premise?.setting && (
                <SectionCard title="Setting" icon={MapPin}>
                  <p className="text-sm leading-relaxed text-muted-foreground">{premise.setting}</p>
                </SectionCard>
              )}
              <SectionCard title="Main Characters" icon={User}>
                <div className="grid sm:grid-cols-2 gap-3">
                  {characters.map((c:any)=>(
                    <div key={c.id} className="p-3 rounded-lg border border-border bg-[hsl(var(--surface-secondary))]">
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 text-xs font-bold flex items-center justify-center">{c.name?.[0]}</div>
                        <div>
                          <div className="font-semibold text-sm">{c.name}</div>
                          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{c.role}</div>
                        </div>
                      </div>
                      {c.personality && <p className="text-xs text-muted-foreground line-clamp-2 mt-1">{c.personality}</p>}
                      {c.arc && <p className="text-xs mt-1 text-primary/90 italic line-clamp-2">Arc: {c.arc}</p>}
                    </div>
                  ))}
                </div>
              </SectionCard>
              {worldRules.length > 0 && (
                <SectionCard title="World Rules" icon={Scroll}>
                  <div className="space-y-2">
                    {worldRules.map((r:any)=>(
                      <div key={r.id} className="flex gap-3">
                        <span className="chip chip-primary mt-0.5 shrink-0">{r.category}</span>
                        <div>
                          <div className="font-semibold text-sm">{r.name}</div>
                          <div className="text-xs text-muted-foreground">{r.description}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </SectionCard>
              )}
            </>
          ) : (
            <div className="surface p-12 text-center">
              <Sparkles className="w-10 h-10 text-primary/50 mx-auto mb-4" />
              <p className="text-muted-foreground">Generate your foundation to see your premise, characters, and world come to life.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionCard({ title, icon:Icon, children }:{title:string; icon:any; children:React.ReactNode}) {
  return (
    <div className="surface p-6">
      <div className="flex items-center gap-2 mb-4">
        <Icon className="w-4 h-4 text-primary" />
        <h3 className="font-serif text-lg font-semibold">{title}</h3>
      </div>
      {children}
    </div>
  );
}
