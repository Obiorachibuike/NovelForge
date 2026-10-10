'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, FileText, File, Download, Check, BookOpen, FileType, FileCode, FileJson } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const FORMATS = [
  { id:'pdf', label:'PDF', desc:'Print-ready manuscript', icon: File },
  { id:'docx', label:'DOCX', desc:'Editable Word document', icon: FileText },
  { id:'epub', label:'EPUB', desc:'E-reader format', icon: BookOpen },
  { id:'txt', label:'TXT', desc:'Plain text', icon: FileType },
  { id:'markdown', label:'Markdown', desc:'MD for further editing', icon: FileCode },
] as const;

export default function ExportView({ novel, settings, exports }: any) {
  const qc = useQueryClient();
  const [format, setFormat] = useState<string>('docx');
  const [opts, setOpts] = useState({
    pageSize: settings.pageSize || 'letter',
    fontFamily: settings.fontFamily || 'serif',
    fontSize: settings.fontSize || 12,
    lineSpacing: settings.lineSpacing || 1.6,
    includeToc: !!settings.includeToc,
    includeFrontMatter: !!settings.includeFrontMatter,
  });
  const mut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/novels/${novel.id}/export`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ format, options: opts }) });
      if (!res.ok) throw new Error((await res.json()).error || 'Export failed');
      return res.json();
    },
    onSuccess: () => { toast.success('Export queued — will download when ready.'); setTimeout(()=>{qc.invalidateQueries();},1500); },
    onError: (e:any)=>toast.error(e.message),
  });

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <div className="label text-primary mb-2">STAGE 10 · EXPORT</div>
        <h1 className="font-serif text-3xl font-semibold">Your story, ready for the world.</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">Export a formatted manuscript. Page count is estimated during layout; the formatted document is the source of truth.</p>
      </div>

      <div className="grid md:grid-cols-[1fr_360px] gap-6">
        <div>
          <div className="label mb-3">Choose format</div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
            {FORMATS.map(f=>(
              <button key={f.id} onClick={()=>setFormat(f.id)} className={cn(
                'surface p-4 text-left transition card-hover',
                format===f.id && 'border-primary shadow-[0_0_0_1px_hsl(var(--primary))]'
              )}>
                <div className="flex items-center justify-between mb-2">
                  <f.icon className={cn('w-6 h-6', format===f.id?'text-primary':'text-muted-foreground')}/>
                  {format===f.id && <Check className="w-4 h-4 text-primary"/>}
                </div>
                <div className="font-semibold text-sm">{f.label}</div>
                <div className="text-xs text-muted-foreground">{f.desc}</div>
              </button>
            ))}
          </div>

          <div className="surface p-6 space-y-4">
            <h3 className="font-serif text-lg font-semibold">Formatting options</h3>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Page size">
                <select className="input" value={opts.pageSize} onChange={e=>setOpts({...opts,pageSize:e.target.value})}>
                  {['letter','a4','a5','trade'].map(s=><option key={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Font family">
                <select className="input" value={opts.fontFamily} onChange={e=>setOpts({...opts,fontFamily:e.target.value})}>
                  <option value="serif">Serif (default)</option>
                  <option value="sans">Sans-serif</option>
                  <option value="mono">Mono</option>
                </select>
              </Field>
              <Field label="Font size (pt)">
                <input type="number" className="input" min={8} max={24} value={opts.fontSize} onChange={e=>setOpts({...opts,fontSize:+e.target.value})}/>
              </Field>
              <Field label="Line spacing">
                <input type="number" step="0.1" min={1} max={3} className="input" value={opts.lineSpacing} onChange={e=>setOpts({...opts,lineSpacing:+e.target.value})}/>
              </Field>
            </div>
            <div className="flex flex-col gap-2">
              <Toggle label="Include table of contents" value={opts.includeToc} onChange={v=>setOpts({...opts,includeToc:v})}/>
              <Toggle label="Include front matter (title page, copyright)" value={opts.includeFrontMatter} onChange={v=>setOpts({...opts,includeFrontMatter:v})}/>
            </div>
          </div>

          <button className="btn-primary w-full mt-6" onClick={()=>mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? <Loader2 className="w-4 h-4 animate-spin"/> : <Download className="w-4 h-4"/>} Prepare export
          </button>
        </div>

        <div className="surface p-5 h-fit">
          <h3 className="font-serif text-lg font-semibold mb-3">Previous exports</h3>
          {exports.length === 0 ? (
            <p className="text-sm text-muted-foreground">No exports yet.</p>
          ) : (
            <div className="space-y-2">
              {exports.map((e:any)=>(
                <a key={e.id} href={e.fileUrl} target="_blank" rel="noopener" className="flex items-center gap-3 p-2 rounded-lg hover:bg-[hsl(var(--surface-secondary))] transition">
                  <div className="w-9 h-9 rounded-md bg-primary/15 text-primary flex items-center justify-center">
                    <Download className="w-4 h-4"/>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm uppercase">{e.format}</div>
                    <div className="text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</div>
                  </div>
                  {e.status==='completed' ? <span className="chip chip-success">Ready</span> :
                   e.status==='failed' ? <span className="chip chip-error">Failed</span> :
                   <span className="chip chip-primary"><Loader2 className="w-3 h-3 animate-spin"/></span>}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({label,children}:{label:string;children:React.ReactNode}){
  return <label className="block space-y-1.5">
    <span className="label">{label}</span>
    {children}
  </label>;
}
function Toggle({label,value,onChange}:{label:string;value:boolean;onChange:(v:boolean)=>void}) {
  return <button type="button" onClick={()=>onChange(!value)} className="flex items-center justify-between w-full p-2 rounded-md hover:bg-[hsl(var(--surface-secondary))]">
    <span className="text-sm">{label}</span>
    <span className={cn('w-10 h-5 rounded-full relative transition', value?'bg-primary':'bg-white/10')}>
      <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white transition', value?'left-5':'left-0.5')}/>
    </span>
  </button>;
}
