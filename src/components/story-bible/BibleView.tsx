'use client';
import { useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { User, MapPin, Scroll, Clock, GitBranch, BookOpen } from 'lucide-react';

const TABS = [
  { key:'overview', label:'Overview', icon: BookOpen },
  { key:'characters', label:'Characters', icon: User },
  { key:'locations', label:'Locations', icon: MapPin },
  { key:'world', label:'World Rules', icon: Scroll },
  { key:'timeline', label:'Timeline', icon: Clock },
  { key:'threads', label:'Plot Threads', icon: GitBranch },
];

export default function BibleView({ novel, premise, bible, characters, locations, rules, threads, timeline }: any) {
  const [tab, setTab] = useState('overview');

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <div className="label text-primary mb-2">STORY BIBLE</div>
        <h1 className="font-serif text-3xl font-semibold">The world behind the words.</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">A living reference for every character, place, rule, and promise. Updated automatically after each approved chapter.</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-border overflow-x-auto">
        {TABS.map(t=>(
          <button key={t.key} onClick={()=>setTab(t.key)} className={cn(
            'flex items-center gap-2 px-4 py-2.5 text-sm border-b-2 transition whitespace-nowrap',
            tab===t.key ? 'border-primary text-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'
          )}>
            <t.icon className="w-4 h-4" />{t.label}
          </button>
        ))}
      </div>

      {tab==='overview' && (
        <div className="space-y-5">
          <Card>
            <h3 className="font-serif text-lg font-semibold mb-2">Synopsis</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">{premise?.shortSynopsis || bible?.overview || 'No overview yet — generate preparation to see your synopsis.'}</p>
          </Card>
          {bible?.toneNotes && <Card><h3 className="font-serif text-lg font-semibold mb-2">Tone</h3><p className="text-sm text-muted-foreground">{bible.toneNotes}</p></Card>}
          {premise?.themes && <Card><h3 className="font-serif text-lg font-semibold mb-2">Themes</h3><div className="flex flex-wrap gap-2">{parseJson(premise.themes,[] as string[]).map((t:string,i:number)=>(<span key={i} className="chip chip-primary">{t}</span>))}</div></Card>}
        </div>
      )}

      {tab==='characters' && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {characters.length === 0 ? <Empty label="No characters yet." /> : characters.map((c:any)=>(
            <div key={c.id} className="surface p-4 card-hover">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 font-bold text-sm flex items-center justify-center">{c.name?.[0]}</div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm truncate">{c.name}</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{c.role}{c.age ? ` · ${c.age}` : ''}</div>
                </div>
              </div>
              {c.personality && <p className="text-xs text-muted-foreground mb-2 leading-relaxed">{c.personality}</p>}
              {c.motivation && <p className="text-xs mb-1"><b className="text-muted-foreground font-semibold">Motivation: </b>{c.motivation}</p>}
              {c.goals && <p className="text-xs mb-1"><b className="text-muted-foreground font-semibold">Goal: </b>{c.goals}</p>}
              {c.fears && <p className="text-xs mb-1"><b className="text-muted-foreground font-semibold">Fears: </b>{c.fears}</p>}
              {c.arc && <p className="text-xs mt-2 pt-2 border-t border-border italic text-primary/90">{c.arc}</p>}
            </div>
          ))}
        </div>
      )}

      {tab==='locations' && (
        <div className="grid sm:grid-cols-2 gap-4">
          {locations.length === 0 ? <Empty label="No locations yet." /> : locations.map((l:any)=>(
            <div key={l.id} className="surface p-4">
              <div className="flex items-center gap-2 mb-2">
                <MapPin className="w-4 h-4 text-primary" />
                <h3 className="font-semibold">{l.name}</h3>
                {l.kind && <span className="chip chip-muted ml-auto">{l.kind}</span>}
              </div>
              <p className="text-sm text-muted-foreground">{l.description}</p>
            </div>
          ))}
        </div>
      )}

      {tab==='world' && (
        <div className="space-y-3">
          {rules.length === 0 ? <Empty label="No world rules yet." /> : rules.map((r:any)=>(
            <div key={r.id} className="surface p-4">
              <div className="flex items-start gap-3">
                <span className="chip chip-primary mt-1 shrink-0">{r.category}</span>
                <div>
                  <h3 className="font-semibold mb-1">{r.name}</h3>
                  <p className="text-sm text-muted-foreground">{r.description}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab==='timeline' && (
        <div className="space-y-3 pl-4 border-l-2 border-border">
          {timeline.length === 0 ? <Empty label="No timeline events yet. They'll populate as you approve chapters." /> : timeline.map((e:any,i:number)=>(
            <div key={e.id} className="relative pl-6 pb-3">
              <div className="absolute -left-[9px] top-1.5 w-4 h-4 rounded-full bg-primary border-4 border-[hsl(var(--background))]" />
              <div className="text-xs text-muted-foreground font-mono">{e.when || `Event ${i+1}`}</div>
              <div className="font-semibold text-sm">{e.label}</div>
              <p className="text-xs text-muted-foreground mt-0.5">{e.description}</p>
            </div>
          ))}
        </div>
      )}

      {tab==='threads' && (
        <div className="space-y-3">
          {threads.length === 0 ? <Empty label="No plot threads tracked yet." /> : threads.map((t:any)=>(
            <div key={t.id} className="surface p-4 flex items-start gap-3">
              <GitBranch className={cn('w-4 h-4 mt-1',
                t.status==='resolved' ? 'text-emerald-400' : t.status==='progressing' ? 'text-primary' : 'text-amber-400')}/>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-sm">{t.title}</h3>
                  <span className={cn('chip', t.status==='resolved'?'chip-success':t.status==='progressing'?'chip-primary':'chip-warning')}>{t.status}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{t.description}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="surface p-6">{children}</div>;
}
function Empty({ label }: { label: string }) {
  return <div className="surface p-10 text-center text-sm text-muted-foreground">{label}</div>;
}
function parseJson(s:any, fallback:any) { try { return JSON.parse(s); } catch { return fallback; } }
