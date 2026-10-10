'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createNovelSchema } from '@/types';
import { toast } from 'sonner';
import { useMutation } from '@tanstack/react-query';
import { BookOpen, Loader2, Sparkles, ArrowRight } from 'lucide-react';
const GENRES=['Fantasy','Science Fiction','Romance','Thriller','Mystery','Historical','Horror','Literary','YA','Memoir'];
const POVS=['First Person','Third Person Limited','Third Person Omniscient','Second Person','Dual POV'];
const AUDIENCES=['Adult','Young Adult','Middle Grade','Children','General'];
const TONES=['Dark, emotional, suspenseful','Warm, hopeful, romantic','Fast-paced, wry, adventurous','Lyrical, atmospheric','Dry, witty, clever'];
const TARGET_WORDS=[50000,80000,100000,120000];
export default function NewNovelForm(){
  const router=useRouter();
  const [step,setStep]=useState(1);
  const form=useForm({resolver:zodResolver(createNovelSchema),defaultValues:{title:'',premise:'',genre:'Fantasy',tone:'Dark, emotional, suspenseful',style:'',pov:'Third Person Limited',audience:'Adult',targetWords:80000,targetPages:250,targetChapters:30,writingMode:'chapter'}});
  const mut=useMutation({mutationFn:async v=>{const r=await fetch('/api/novels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(v)});if(!r.ok)throw new Error((await r.json()).error||'Failed');return r.json();},onSuccess:d=>{toast.success('Novel created');router.push(`/novels/${d.id}/cover`);},onError:e=>toast.error(e.message)});
  return <div className="flex-1 overflow-y-auto"><div className="max-w-3xl mx-auto px-8 py-12">
    <div className="mb-10"><div className="label text-primary mb-2">STAGE 1 · CREATE</div><h1 className="font-serif text-4xl font-semibold mb-2">Begin with a spark.</h1><p className="text-muted-foreground max-w-xl">Tell us the shape of the story you want to build. You can change every setting later.</p></div>
    <div className="surface p-8">
      <form onSubmit={form.handleSubmit(v=>mut.mutate(v))} className="space-y-6">
        {step===1 && <>
          <Field label="Novel title"><input className="input font-serif text-lg" placeholder="The name of your story" {...form.register('title')} autoFocus/>{form.formState.errors.title&&<Err>{form.formState.errors.title.message}</Err>}</Field>
          <Field label="Premise (optional)" hint="A sentence, a feeling, a question."><textarea className="input min-h-[100px] resize-y" placeholder="When an exiled heir returns..." {...form.register('premise')}/></Field>
          <div className="grid md:grid-cols-2 gap-4">
            <Field label="Genre"><select className="input" {...form.register('genre')}>{GENRES.map(g=><option key={g}>{g}</option>)}</select></Field>
            <Field label="Point of view"><select className="input" {...form.register('pov')}>{POVS.map(g=><option key={g}>{g}</option>)}</select></Field>
            <Field label="Audience"><select className="input" {...form.register('audience')}>{AUDIENCES.map(g=><option key={g}>{g}</option>)}</select></Field>
            <Field label="Tone"><select className="input" {...form.register('tone')}>{TONES.map(g=><option key={g}>{g}</option>)}</select></Field>
          </div>
          <button type="button" onClick={()=>setStep(2)} className="btn-primary w-full">Continue <ArrowRight className="w-4 h-4"/></button>
        </>}
        {step===2 && <>
          <div className="grid md:grid-cols-3 gap-4">
            <Field label="Target words"><select className="input" {...form.register('targetWords',{valueAsNumber:true})}>{TARGET_WORDS.map(w=><option key={w} value={w}>{w.toLocaleString()}</option>)}</select></Field>
            <Field label="Target pages"><input type="number" className="input" {...form.register('targetPages',{valueAsNumber:true})} min={5} max={2000}/></Field>
            <Field label="Target chapters"><input type="number" className="input" {...form.register('targetChapters',{valueAsNumber:true})} min={1} max={100}/></Field>
          </div>
          <Field label="Writing mode">
            <div className="grid grid-cols-2 gap-3">
              <ModeCard active={form.watch('writingMode')==='chapter'} onClick={()=>form.setValue('writingMode','chapter')} title="Chapter by chapter" desc="Generate and approve one chapter at a time. Recommended."/>
              <ModeCard active={form.watch('writingMode')==='page'} onClick={()=>form.setValue('writingMode','page')} title="Page by page" desc="Shorter units, finer control."/>
            </div>
          </Field>
          <Field label="Writing style (optional)" hint="e.g. sparse and cinematic"><input className="input" placeholder="What should the prose feel like?" {...form.register('style')}/></Field>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={()=>setStep(1)} className="btn-secondary flex-1">Back</button>
            <button className="btn-primary flex-[2]" disabled={mut.isPending}>{mut.isPending?<Loader2 className="w-4 h-4 animate-spin"/> : <><Sparkles className="w-4 h-4"/> Create novel & generate cover</>}</button>
          </div>
        </>}
      </form>
    </div>
  </div></div>;
}
function Field({label,hint,children}){return <label className="block space-y-2"><div><div className="label">{label}</div>{hint&&<div className="text-xs text-muted-foreground">{hint}</div>}</div>{children}</label>;}
function Err({children}){return <div className="text-xs text-destructive mt-1">{children}</div>;}
function ModeCard({active,onClick,title,desc}){return <button type="button" onClick={onClick} className={`text-left p-4 rounded-lg border transition ${active?'border-primary bg-primary/10':'border-border bg-[hsl(var(--surface-secondary))] hover:border-primary/40'}`}><div className="font-semibold text-sm mb-1">{title}</div><div className="text-xs text-muted-foreground">{desc}</div></button>;}
