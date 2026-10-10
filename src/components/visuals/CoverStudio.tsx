'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Check, Wand2, ArrowRight, Loader2, Image as ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export default function CoverStudio({ novel, initialCovers }: { novel: any; initialCovers: any[] }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [variants, setVariants] = useState(3);
  const [selectedId, setSelectedId] = useState<string | null>(initialCovers.find(c=>c.isPrimary)?.id || null);

  const { data: covers = initialCovers } = useQuery({
    queryKey:['covers', novel.id],
    queryFn: async () => (await fetch(`/api/novels/${novel.id}/cover`).then(r=>r.json())) as any[],
    initialData: initialCovers,
  });

  const gen = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/novels/${novel.id}/cover`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ prompt: prompt || undefined, variants }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Generation failed');
      return res.json();
    },
    onSuccess: () => { toast.success('Cover concepts generated'); qc.invalidateQueries({queryKey:['covers',novel.id]}); },
    onError: (e:any) => toast.error(e.message),
  });

  const select = useMutation({
    mutationFn: async (imageId: string) => {
      const res = await fetch(`/api/novels/${novel.id}/cover`, {
        method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ imageId }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      return res.json();
    },
    onSuccess: (_, imageId) => { setSelectedId(imageId); toast.success('Cover selected — story preparation is next'); qc.invalidateQueries({queryKey:['covers',novel.id]}); },
    onError: (e:any) => toast.error(e.message),
  });

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <div className="label text-primary mb-2">STAGE 2 · COVER</div>
        <h1 className="font-serif text-3xl font-semibold">Give your story a face.</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">Generate cover concepts before you begin writing. Pick a primary cover — you can generate more or edit the prompt at any time.</p>
      </div>

      <div className="surface p-6 mb-8">
        <div className="grid md:grid-cols-[1fr_auto_auto] gap-4 items-end">
          <div>
            <label className="label block mb-2">Cover prompt (optional)</label>
            <input className="input" placeholder="Leave blank for an auto-generated cinematic hardcover concept" value={prompt} onChange={e=>setPrompt(e.target.value)} />
          </div>
          <div>
            <label className="label block mb-2">Variants</label>
            <select className="input" value={variants} onChange={e=>setVariants(+e.target.value)}>
              {[1,2,3,4].map(n=><option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <button className="btn-primary" onClick={()=>gen.mutate()} disabled={gen.isPending}>
            {gen.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
            Generate concepts
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-3 flex items-center gap-2">
          <Sparkles className="w-3 h-3" />
          In demo mode, stylized SVG covers are generated instantly. Configure an image provider for AI images.
        </p>
      </div>

      {covers.length === 0 && !gen.isPending && (
        <div className="surface p-16 text-center">
          <ImageIcon className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="font-serif text-xl mb-2">No covers yet</h3>
          <p className="text-sm text-muted-foreground mb-6">Generate the first set of concepts for {novel.title}.</p>
        </div>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
        {covers.map((c:any) => (
          <div key={c.id} className={cn('surface p-3 card-hover', c.id===selectedId && 'border-primary shadow-[0_0_0_1px_hsl(var(--primary))]')}>
            <div className="aspect-[3/4] rounded-md overflow-hidden border border-white/10 relative mb-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.url} alt="" className="w-full h-full object-cover" />
              {c.id===selectedId && <div className="absolute top-2 right-2 bg-primary text-primary-foreground rounded-full p-1"><Check className="w-3 h-3" /></div>}
            </div>
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{c.isPrimary ? 'Primary cover' : `Concept`}</div>
                <div className="text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleDateString()}</div>
              </div>
              {c.id !== selectedId ? (
                <button className="btn-outline text-xs px-3 py-1.5" onClick={()=>select.mutate(c.id)} disabled={select.isPending}>Set primary</button>
              ) : (
                <span className="chip chip-primary">Selected</span>
              )}
            </div>
          </div>
        ))}
        {gen.isPending && Array.from({length: variants}).map((_,i)=>(
          <div key={i} className="surface p-3">
            <div className="aspect-[3/4] rounded-md shimmer mb-3" />
            <div className="h-4 w-1/3 bg-white/5 rounded shimmer mb-2" />
            <div className="h-3 w-1/2 bg-white/5 rounded shimmer" />
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <button
          className="btn-primary"
          disabled={!selectedId}
          onClick={()=>router.push(`/novels/${novel.id}/prepare`)}>
          Continue to Preparation <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
