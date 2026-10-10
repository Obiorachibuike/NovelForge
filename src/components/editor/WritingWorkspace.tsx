'use client';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import History from '@tiptap/extension-history';
import CharacterCount from '@tiptap/extension-character-count';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import LinkNext from 'next/link';
import {
  Bold, Italic, Underline as UnderlineIcon, Highlighter, Undo2, Redo2, AlignLeft, AlignCenter, Quote, List, Heading1,
  Save, Loader2, Sparkles, Wand2, Lock, ChevronRight, ChevronLeft, CheckCircle2, RefreshCw, MessageSquare, Zap
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export default function WritingWorkspace({ novel, chapter, outline, navigation, previousSummary, memories }: any) {
  const router = useRouter();
  const qc = useQueryClient();
  const [saveState, setSaveState] = useState<'idle'|'saving'|'saved'>('saved');
  const [aiState, setAiState] = useState<'idle'|'thinking'|'streaming'>('idle');
  const [selection, setSelection] = useState<string>('');
  const chapterNum = chapter?.chapterNumber || outline?.chapterNumber || 1;
  const title = chapter?.title || outline?.title || `Chapter ${chapterNum}`;
  const targetWords = outline?.targetWords || 2600;
  const targetPages = outline?.estimatedPages || Math.round(targetWords/320);
  const status = chapter?.status || (outline ? 'next' : 'locked');
  const isLocked = status === 'locked';
  const initialContent = chapter?.contentJson ? JSON.parse(chapter.contentJson) : {
    type:'doc', content:[
      chapter ? undefined : { type:'paragraph', content:[{ type:'text', text:'' }] },
    ].filter(Boolean)
  };

  const editor = useEditor({
    extensions:[
      StarterKit.configure({ history:false }),
      History,
      Placeholder.configure({ placeholder: chapter ? 'Continue writing...' : 'Click "Generate Chapter" to begin, or start typing.' }),
      Underline, Highlight,
      Link.configure({ openOnClick:false, HTMLAttributes:{rel:'nofollow noopener'} }),
      TextAlign.configure({ types:['heading','paragraph'] }),
      CharacterCount,
    ],
    content: initialContent,
    editable: !isLocked && !!chapter,
    onSelectionUpdate: ({editor}) => {
      const text = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ');
      setSelection(text.slice(0, 2000));
    },
    onUpdate: () => {
      setSaveState('saving');
      debouncedSave();
    },
  });

  // Debounced autosave
  const saveTimer = useRef<any>(null);
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!editor || !chapter) return;
      const res = await fetch(`/api/novels/${novel.id}/chapters/${chapter.id}`, {
        method:'PATCH', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ contentJson: editor.getJSON() }),
      });
      if (!res.ok) throw new Error('Save failed');
      return res.json();
    },
    onSuccess: () => { setSaveState('saved'); qc.invalidateQueries({queryKey:['novel',novel.id]}); },
    onError: () => toast.error('Could not save — will retry'),
  });
  const debouncedSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(()=>saveMutation.mutate(), 1200);
  }, [saveMutation]);

  useEffect(()=>()=>{ if(saveTimer.current) clearTimeout(saveTimer.current); },[]);

  const generateChapter = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/novels/${novel.id}/chapters`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chapterNumber: chapterNum }) });
      if (!res.ok) throw new Error((await res.json()).error || 'Generation failed');
      return res.json();
    },
    onSuccess: () => { toast.success('Chapter generation queued'); pollForChapter(); },
    onError: (e:any) => toast.error(e.message),
  });

  const approve = useMutation({
    mutationFn: async () => {
      if (!chapter) return;
      const res = await fetch(`/api/novels/${novel.id}/chapters/${chapter.id}/approve`, { method:'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Chapter approved — next unlocked.');
      router.push(`/novels/${novel.id}/write/${chapterNum+1}`);
      qc.invalidateQueries();
    },
    onError: (e:any) => toast.error(e.message),
  });

  const aiAction = useMutation({
    mutationFn: async (action: string) => {
      if (!editor || !chapter) return;
      setAiState('thinking');
      const res = await fetch(`/api/ai/editor-action`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action, selection, chapterId: chapter.id, before: editor.getText().slice(-800) }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'AI action failed');
      setAiState('streaming');
      const data = await res.json();
      // insert or replace
      const { from, to } = editor.state.selection;
      if (editor.state.selection.empty) {
        editor.commands.insertContent(data.text);
      } else {
        editor.chain().focus().deleteRange({from, to}).insertContent(data.text).run();
      }
      setAiState('idle');
    },
    onError: (e:any) => { setAiState('idle'); toast.error(e.message); },
  });

  function pollForChapter() {
    let tries = 0;
    const tick = setInterval(async () => {
      tries++;
      const res = await fetch(`/api/novels/${novel.id}/chapters?chapterNumber=${chapterNum}`);
      if (res.ok) {
        const data = await res.json();
        const found = Array.isArray(data) ? data.find((c:any)=>c.chapterNumber===chapterNum) : null;
        if (found && found.status !== 'queued') { clearInterval(tick); router.refresh(); return; }
      }
      if (tries > 60) clearInterval(tick);
    }, 1500);
  }

  const wordCount = editor?.storage.characterCount?.words?.() ?? chapter?.wordCount ?? 0;
  const pages = Math.max(1, Math.round(wordCount/320));
  const progress = Math.min(100, Math.round((wordCount/targetWords)*100));
  const currentNav = navigation.find((n:any)=>n.chapterNumber===chapterNum);
  const prevNav = navigation.find((n:any)=>n.chapterNumber===chapterNum-1 && n.status==='approved');
  const nextNav = chapter?.status==='approved' ? navigation.find((n:any)=>n.chapterNumber===chapterNum+1) : null;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Chapter list rail */}
      <div className="border-b border-border px-6 py-3 flex items-center gap-2 overflow-x-auto bg-[hsl(var(--surface-secondary))]">
        {navigation.map((n:any)=>(
          <LinkNext key={n.chapterNumber} href={`/novels/${novel.id}/write/${n.chapterNumber}`} className={cn(
            'shrink-0 text-xs font-mono rounded-md px-2.5 py-1 border transition',
            currentNav?.chapterNumber===n.chapterNumber ? 'bg-primary/15 border-primary text-primary' :
            n.status==='approved' ? 'bg-emerald-500/5 border-emerald-500/30 text-emerald-300' :
            n.status==='next' ? 'bg-white/5 border-primary/30 text-primary' :
            'bg-white/5 border-transparent text-muted-foreground',
            n.status==='locked' && 'opacity-40 pointer-events-none'
          )}>
            {n.status==='locked' ? <Lock className="w-3 h-3 inline -mt-0.5 mr-1"/> : null}
            {String(n.chapterNumber).padStart(2,'0')}
          </LinkNext>
        ))}
      </div>

      <div className="flex-1 min-h-0 grid lg:grid-cols-[1fr_320px]">
        {/* Editor */}
        <div className="overflow-y-auto">
          <div className="max-w-3xl mx-auto px-8 py-10">
            <div className="flex items-start justify-between mb-8 flex-wrap gap-4">
              <div>
                <div className="label text-primary mb-2">CHAPTER {String(chapterNum).padStart(2,'0')} · {Math.round(wordCount).toLocaleString()} / {targetWords.toLocaleString()} words</div>
                <h1 className="font-serif text-4xl font-semibold leading-tight mb-2">{title}</h1>
                {outline?.summary && <p className="text-sm text-muted-foreground max-w-xl">{outline.summary}</p>}
              </div>
            </div>

            {/* Toolbar */}
            {editor && !isLocked && (
              <div className="sticky top-0 z-10 -mx-2 px-2 py-2 mb-4 rounded-lg bg-[hsl(var(--surface-secondary))]/90 backdrop-blur flex flex-wrap items-center gap-1 border border-border">
                <ToolBtn onClick={()=>editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')}><Bold className="w-4 h-4"/></ToolBtn>
                <ToolBtn onClick={()=>editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')}><Italic className="w-4 h-4"/></ToolBtn>
                <ToolBtn onClick={()=>editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')}><UnderlineIcon className="w-4 h-4"/></ToolBtn>
                <ToolBtn onClick={()=>editor.chain().focus().toggleHighlight().run()} active={editor.isActive('highlight')}><Highlighter className="w-4 h-4"/></ToolBtn>
                <Divider/>
                <ToolBtn onClick={()=>editor.chain().focus().toggleHeading({level:2}).run()} active={editor.isActive('heading',{level:2})}><Heading1 className="w-4 h-4"/></ToolBtn>
                <ToolBtn onClick={()=>editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')}><List className="w-4 h-4"/></ToolBtn>
                <ToolBtn onClick={()=>editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')}><Quote className="w-4 h-4"/></ToolBtn>
                <ToolBtn onClick={()=>editor.chain().focus().setTextAlign('left').run()} active={editor.isActive({textAlign:'left'})}><AlignLeft className="w-4 h-4"/></ToolBtn>
                <ToolBtn onClick={()=>editor.chain().focus().setTextAlign('center').run()} active={editor.isActive({textAlign:'center'})}><AlignCenter className="w-4 h-4"/></ToolBtn>
                <Divider/>
                <ToolBtn onClick={()=>editor.chain().focus().undo().run()}><Undo2 className="w-4 h-4"/></ToolBtn>
                <ToolBtn onClick={()=>editor.chain().focus().redo().run()}><Redo2 className="w-4 h-4"/></ToolBtn>
                <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground pr-2">
                  {saveState==='saving' && <><Loader2 className="w-3 h-3 animate-spin"/> Saving…</>}
                  {saveState==='saved' && <><Save className="w-3 h-3"/> Saved just now</>}
                </div>
              </div>
            )}

            {!chapter ? (
              <div className="surface p-12 text-center">
                <Wand2 className="w-10 h-10 text-primary/60 mx-auto mb-4"/>
                <h3 className="font-serif text-2xl mb-2">Ready to write</h3>
                <p className="text-sm text-muted-foreground max-w-md mx-auto mb-6">NovelForge will generate the first draft of this chapter, drawing on the Story Bible, outline, and previous chapter summary. You'll be able to edit every word.</p>
                <button className="btn-primary" onClick={()=>generateChapter.mutate()} disabled={generateChapter.isPending || isLocked}>
                  {generateChapter.isPending ? <><Loader2 className="w-4 h-4 animate-spin"/> Generating…</> : <><Sparkles className="w-4 h-4"/> Generate Chapter {chapterNum}</>}
                </button>
                {isLocked && <p className="text-xs text-amber-400 mt-4"><Lock className="w-3 h-3 inline mr-1"/>Previous chapter must be approved first.</p>}
              </div>
            ) : isLocked ? (
              <div className="surface p-12 text-center">
                <Lock className="w-10 h-10 text-muted-foreground mx-auto mb-4"/>
                <h3 className="font-serif text-xl mb-2">Locked</h3>
                <p className="text-sm text-muted-foreground">Approve the previous chapter to unlock this one.</p>
              </div>
            ) : (
              <div className="prose-editor">
                <EditorContent editor={editor} />
              </div>
            )}

            {chapter && !isLocked && (
              <div className="mt-10 pt-6 border-t border-border flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span>{Math.round(wordCount).toLocaleString()} words</span>
                  <span>·</span>
                  <span>{pages} estimated pages</span>
                  <span>·</span>
                  <span>{progress}% of target</span>
                </div>
                <div className="flex items-center gap-2">
                  <button className="btn-outline" onClick={()=>generateChapter.mutate()} disabled={generateChapter.isPending}>
                    <RefreshCw className={cn('w-4 h-4',generateChapter.isPending && 'animate-spin')}/> Regenerate
                  </button>
                  <button className="btn-primary" onClick={()=>approve.mutate()} disabled={approve.isPending || wordCount < 100}>
                    {approve.isPending ? <Loader2 className="w-4 h-4 animate-spin"/> : <CheckCircle2 className="w-4 h-4"/>} Approve & continue
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* AI Panel */}
        <aside className="border-l border-border bg-[hsl(var(--surface))] overflow-y-auto p-5 space-y-5 hidden lg:block">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-primary/15 text-primary flex items-center justify-center"><Sparkles className="w-4 h-4"/></div>
              <div>
                <div className="font-semibold text-sm">Forge Assistant</div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Context-aware partner</div>
              </div>
            </div>
            {aiState !== 'idle' && (
              <div className="typing-indicator text-xs text-primary mt-2">Thinking<span/><span/><span/></div>
            )}
          </div>

          <div className="surface-secondary p-3 rounded-lg">
            <div className="text-[10px] font-semibold tracking-widest text-emerald-400 mb-1">CONTEXT LOADED</div>
            <p className="text-xs text-muted-foreground">Outline · Story Bible {previousSummary ? '· Previous chapter' : ''} · {memories.length} memories</p>
          </div>

          {chapter && (
            <div className="space-y-2">
              <div className="label mb-2">Editor actions</div>
              {[
                { k:'continue', label:'Continue scene', icon: Zap },
                { k:'rewrite', label:'Rewrite selection', icon: RefreshCw },
                { k:'expand', label:'Expand', icon: Wand2 },
                { k:'shorten', label:'Shorten', icon: Wand2 },
                { k:'improve', label:'Improve prose', icon: Sparkles },
                { k:'dialogue', label:'Improve dialogue', icon: MessageSquare },
              ].map(b=>(
                <button key={b.k} onClick={()=>aiAction.mutate(b.k)} disabled={aiState!=='idle' || !editor} className="w-full text-left p-2.5 rounded-lg text-sm border border-border bg-[hsl(var(--surface-secondary))] hover:border-primary/40 hover:text-primary transition flex items-center gap-2">
                  <b.icon className="w-4 h-4"/> {b.label}
                </button>
              ))}
            </div>
          )}

          {outline && (
            <div className="surface-secondary p-3 rounded-lg">
              <div className="text-[10px] font-semibold tracking-widest text-amber-400 mb-1">NARRATIVE TARGET</div>
              <p className="text-xs text-muted-foreground">{outline.narrativePurpose || outline.conflict || 'Advance the plot and deepen the characters.'}</p>
            </div>
          )}

          {previousSummary && (
            <div className="surface-secondary p-3 rounded-lg">
              <div className="text-[10px] font-semibold tracking-widest text-primary mb-1">PREVIOUSLY</div>
              <p className="text-xs text-muted-foreground line-clamp-6">{previousSummary}</p>
            </div>
          )}

          <div>
            <div className="label mb-2">Progress</div>
            <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
              <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{width:`${progress}%`}}/>
            </div>
            <div className="flex justify-between text-[11px] text-muted-foreground mt-1.5 font-mono">
              <span>{Math.round(wordCount).toLocaleString()} words</span>
              <span>{targetWords.toLocaleString()} goal</span>
            </div>
          </div>
        </aside>
      </div>

      {/* Bottom nav */}
      <div className="border-t border-border px-6 py-3 flex items-center justify-between bg-[hsl(var(--surface-secondary))]">
        {prevNav ? (
          <LinkNext href={`/novels/${novel.id}/write/${prevNav.chapterNumber}`} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="w-4 h-4"/> Chapter {prevNav.chapterNumber}
          </LinkNext>
        ) : <span/>}
        {nextNav ? (
          <LinkNext href={`/novels/${novel.id}/write/${nextNav.chapterNumber}`} className="flex items-center gap-2 text-sm text-primary font-medium">
            Chapter {nextNav.chapterNumber} <ChevronRight className="w-4 h-4"/>
          </LinkNext>
        ) : chapter?.status === 'approved' ? (
          <LinkNext href={`/novels/${novel.id}/consistency`} className="flex items-center gap-2 text-sm text-primary font-medium">Run consistency check <ChevronRight className="w-4 h-4"/></LinkNext>
        ) : <span/>}
      </div>
    </div>
  );
}

function ToolBtn({ children, onClick, active }: { children: React.ReactNode; onClick: ()=>void; active?: boolean }) {
  return <button onClick={onClick} className={cn('w-8 h-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-white/5 transition', active && 'bg-primary/15 text-primary')}>{children}</button>;
}
function Divider() { return <div className="w-px h-5 bg-border mx-1"/>; }
