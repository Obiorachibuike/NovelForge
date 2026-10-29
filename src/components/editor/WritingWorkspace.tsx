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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import LinkNext from 'next/link';
import {
  Bold, Italic, Underline as UnderlineIcon, Highlighter, Undo2, Redo2, AlignLeft, AlignCenter, Quote, List, Heading1,
  Save, Loader2, Sparkles, Wand2, Lock, ChevronRight, ChevronLeft, CheckCircle2, RefreshCw, MessageSquare, Zap,
  AlertTriangle, History as HistoryIcon, RotateCcw, Eye, X
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useJobWatcher } from '@/lib/hooks/useJobWatcher';
import {
  createAutosaveController,
  loadLocalDraft,
  clearLocalDraft,
  hasRecoverableDraft,
  extractPlainTextFromDoc,
  type AutosaveState,
  type DraftRecoveryEntry,
} from '@/lib/editor/draft-recovery';

function formatSaveTime(iso: string | null | undefined): string {
  if (!iso) return 'just now';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'just now';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return 'just now';
  }
}

export default function WritingWorkspace({
  novel,
  chapter,
  outline,
  navigation,
  previousSummary,
  memories,
  initialVersions = [],
  autoGenerate = false,
}: any) {
  const router = useRouter();
  const qc = useQueryClient();
  const [aiState, setAiState] = useState<'idle' | 'thinking' | 'streaming'>('idle');
  const [selection, setSelection] = useState<string>('');
  const [versions, setVersions] = useState<any[]>(initialVersions);
  const [showCompareRecovery, setShowCompareRecovery] = useState(false);
  const [recoveredDraft, setRecoveredDraft] = useState<DraftRecoveryEntry | null>(null);
  const [readingGeneration, setReadingGeneration] = useState(chapter?.status === 'generated' && chapter?.generationSource !== 'demo');
  const [previewVersion, setPreviewVersion] = useState<any | null>(null);

  const chapterNum = chapter?.chapterNumber || outline?.chapterNumber || 1;
  const title = chapter?.title || outline?.title || `Chapter ${chapterNum}`;
  const targetWords = outline?.targetWords || 2600;
  const status = chapter?.status || (outline ? 'next' : 'locked');
  const isLocked = status === 'locked';
  // Approved chapters are final until a future "reopen" action exists, so the
  // editor must not pretend they are editable: autosave would fail server-side
  // and the author's typing would be lost.
  const isApproved = chapter?.status === 'approved';
  const isDemoContent = chapter?.generationSource === 'demo';

  const initialContent = useMemo(() => {
    if (chapter?.contentJson) {
      try {
        return JSON.parse(chapter.contentJson);
      } catch {
        // fall through
      }
    }
    return {
      type: 'doc',
      content: [chapter ? undefined : { type: 'paragraph', content: [{ type: 'text', text: '' }] }].filter(Boolean),
    };
  }, [chapter]);

  const [autosaveState, setAutosaveState] = useState<AutosaveState>({
    status: 'saved',
    revision: chapter?.revision ?? 1,
    lastSavedAt: chapter?.updatedAt ?? null,
    errorMessage: null,
    retryCount: 0,
  });

  const controllerRef = useRef<ReturnType<typeof createAutosaveController> | null>(null);

  useEffect(() => {
    if (!chapter?.id || isApproved || isLocked) {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      return;
    }

    // Check if browser storage has a recoverable unsaved draft for this chapter.
    const local = loadLocalDraft(novel.id, chapter.id);
    if (hasRecoverableDraft(local, chapter.contentJson)) {
      setRecoveredDraft(local);
    } else {
      setRecoveredDraft(null);
    }

    const ctrl = createAutosaveController({
      novelId: novel.id,
      chapterId: chapter.id,
      chapterNumber: chapterNum,
      initialContentJson: initialContent,
      initialRevision: chapter.revision ?? 1,
      initialUpdatedAt: chapter.updatedAt ?? null,
      delayMs: 1200,
      maxRetries: 3,
      baseRetryMs: 1000,
      onStateChange: (next) => {
        setAutosaveState(next);
      },
      transport: async ({ contentJson, expectedRevision, createSnapshot, snapshotNote, signal }) => {
        const res = await fetch(`/api/novels/${novel.id}/chapters/${chapter.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contentJson,
            expectedRevision,
            createSnapshot,
            snapshotNote,
          }),
          signal,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          const err: any = new Error(data.error || 'Save failed');
          err.code = data.code;
          err.status = res.status;
          err.currentRevision = data.currentRevision;
          throw err;
        }
        const data = await res.json();
        qc.invalidateQueries({ queryKey: ['novel', novel.id] });
        if (createSnapshot) {
          fetch(`/api/novels/${novel.id}/chapters/${chapter.id}/versions`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => { if (d?.versions) setVersions(d.versions); })
            .catch(() => {});
        }
        return data;
      },
    });
    controllerRef.current = ctrl;
    return () => {
      ctrl.dispose();
      controllerRef.current = null;
    };
  }, [chapter?.id, chapter?.contentJson, chapter?.revision, chapter?.updatedAt, chapterNum, initialContent, isApproved, isLocked, novel.id, qc]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ history: false }),
      History,
      Placeholder.configure({ placeholder: chapter ? 'Continue writing...' : 'Click "Generate Chapter" to begin, or start typing.' }),
      Underline,
      Highlight,
      Link.configure({ openOnClick: false, HTMLAttributes: { rel: 'nofollow noopener' } }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      CharacterCount,
    ],
    content: initialContent,
    editable: !isLocked && !!chapter && !isApproved,
    onSelectionUpdate: ({ editor }) => {
      const text = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ');
      setSelection(text.slice(0, 2000));
    },
    onUpdate: ({ editor }) => {
      controllerRef.current?.notifyEdit(editor.getJSON() as any);
    },
  });

  // Warn users before navigating away when unsaved changes exist.
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (controllerRef.current?.hasUnsavedChanges()) {
        e.preventDefault();
        e.returnValue = 'You have unsaved changes in this chapter.';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  const handleManualSave = useCallback(async () => {
    if (!controllerRef.current || !editor || !chapter || isApproved) return;
    const res = await controllerRef.current.saveNow({ createSnapshot: true, snapshotNote: 'Manual save' });
    if (res) {
      toast.success('Chapter saved');
    } else if (controllerRef.current.getState().status === 'error') {
      toast.error(controllerRef.current.getState().errorMessage || 'Could not save chapter');
    }
  }, [chapter, editor, isApproved]);

  // Support Ctrl+S / Cmd+S keyboard shortcut for manual save.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleManualSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleManualSave]);

  const handleRestoreDraft = useCallback(async () => {
    if (!recoveredDraft || !editor || !chapter) return;
    editor.commands.setContent(recoveredDraft.contentJson);
    setRecoveredDraft(null);
    setShowCompareRecovery(false);
    controllerRef.current?.notifyEdit(recoveredDraft.contentJson);
    await controllerRef.current?.saveNow({ createSnapshot: true, snapshotNote: 'Restored recovered draft' });
    toast.success('Recovered draft restored and saved.');
  }, [chapter, editor, recoveredDraft]);

  const handleDiscardDraft = useCallback(() => {
    if (!chapter) return;
    clearLocalDraft(novel.id, chapter.id);
    setRecoveredDraft(null);
    setShowCompareRecovery(false);
    toast.message('Recovered draft discarded.');
  }, [chapter, novel.id]);

  const restoreRevisionMutation = useMutation({
    mutationFn: async (versionId: string) => {
      if (!chapter) throw new Error('No chapter');
      const res = await fetch(`/api/novels/${novel.id}/chapters/${chapter.id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', versionId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not restore revision');
      }
      return res.json();
    },
    onSuccess: (data: any) => {
      if (data.contentJson && editor) {
        editor.commands.setContent(data.contentJson);
        controllerRef.current?.acceptExternalContent(data.contentJson, data.revision, data.updatedAt);
      }
      if (Array.isArray(data.versions)) setVersions(data.versions);
      setPreviewVersion(null);
      toast.success(`Restored version v${data.restoredVersion}`);
      router.refresh();
    },
    onError: (err: any) => toast.error(err.message),
  });

  const inspectVersion = useCallback(async (versionId: string) => {
    if (!chapter) return;
    const res = await fetch(`/api/novels/${novel.id}/chapters/${chapter.id}/versions?versionId=${versionId}`);
    if (res.ok) {
      setPreviewVersion(await res.json());
    }
  }, [chapter, novel.id]);

  const generateChapter = useMutation({
    mutationFn: async () => {
      // Regenerating a chapter that contains the author's own edits replaces
      // their prose, so it requires an explicit confirmation.
      const needsConfirmation = chapter?.status === 'edited' || autosaveState.status === 'unsaved';
      if (needsConfirmation && !window.confirm('This chapter contains your edits. Regenerating will replace them. Continue?')) {
        throw new Error('cancelled');
      }
      const res = await fetch(`/api/novels/${novel.id}/chapters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapterNumber: chapterNum, confirmOverwrite: needsConfirmation }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err: any = new Error(data.error || 'Generation failed');
        err.code = data.code;
        throw err;
      }
      return res.json();
    },
    onSuccess: (data: any) => {
      setReadingGeneration(true);
      toast.success('Chapter generation queued');
      if (data?.jobId) watch(data.jobId);
      else pollForChapter();
    },
    onError: (e: any) => {
      if (e?.message !== 'cancelled') toast.error(e.message);
    },
  });

  const approve = useMutation({
    mutationFn: async () => {
      if (!chapter) return;
      // Ensure any pending edits are saved before approving.
      if (controllerRef.current?.hasUnsavedChanges()) {
        const saved = await controllerRef.current.saveNow();
        if (!saved) throw new Error('Save your changes before continuing.');
      }
      const res = await fetch(`/api/novels/${novel.id}/chapters/${chapter.id}/approve`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Chapter approved — next unlocked.');
      router.push(`/novels/${novel.id}/write/${chapterNum + 1}?generate=1`);
      qc.invalidateQueries();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const aiAction = useMutation({
    mutationFn: async (action: string) => {
      if (!editor || !chapter) return;
      setAiState('thinking');
      const res = await fetch(`/api/ai/editor-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        editor.chain().focus().deleteRange({ from, to }).insertContent(data.text).run();
      }
      setAiState('idle');
    },
    onError: (e: any) => {
      setAiState('idle');
      toast.error(e.message);
    },
  });

  const { job: generationJob, watch } = useJobWatcher({
    onComplete: () => {
      toast.success('Chapter ready');
      router.refresh();
    },
    onFail: (job) => { setReadingGeneration(false); toast.error(`Generation failed: ${job.error || 'unknown error'}`); },
  });
  // The durable job row is the truth: the button stays busy while it runs, even
  // across a page refresh.
  const isWritingJob = generationJob?.status === 'queued' || generationJob?.status === 'processing';

  function pollForChapter() {
    let tries = 0;
    const tick = setInterval(async () => {
      tries++;
      const res = await fetch(`/api/novels/${novel.id}/chapters?chapterNumber=${chapterNum}`);
      if (res.ok) {
        const data = await res.json();
        const found = Array.isArray(data) ? data.find((c: any) => c.chapterNumber === chapterNum) : null;
        if (found && found.status !== 'queued') {
          clearInterval(tick);
          router.refresh();
          return;
        }
      }
      if (tries > 60) clearInterval(tick);
    }, 1500);
  }

  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoGenerate && !chapter && !isLocked && !autoStarted.current) {
      autoStarted.current = true;
      generateChapter.mutate();
    }
  }, [autoGenerate, chapter, isLocked, generateChapter]);

  const wordCount = editor?.storage.characterCount?.words?.() ?? chapter?.wordCount ?? 0;
  const pages = Math.max(1, Math.round(wordCount / 320));
  const progress = Math.min(100, Math.round((wordCount / targetWords) * 100));
  const currentNav = navigation.find((n: any) => n.chapterNumber === chapterNum);
  const prevNav = navigation.find((n: any) => n.chapterNumber === chapterNum - 1 && n.status === 'approved');
  const nextNav = chapter?.status === 'approved' ? navigation.find((n: any) => n.chapterNumber === chapterNum + 1) : null;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Chapter list rail */}
      <div className="border-b border-border px-6 py-3 flex items-center gap-2 overflow-x-auto bg-[hsl(var(--surface-secondary))]">
        {navigation.map((n: any) => (
          <LinkNext
            key={n.chapterNumber}
            href={`/novels/${novel.id}/write/${n.chapterNumber}`}
            className={cn(
              'shrink-0 text-xs font-mono rounded-md px-2.5 py-1 border transition',
              currentNav?.chapterNumber === n.chapterNumber ? 'bg-primary/15 border-primary text-primary' :
              n.status === 'approved' ? 'bg-emerald-500/5 border-emerald-500/30 text-emerald-300' :
              n.status === 'next' ? 'bg-white/5 border-primary/30 text-primary' :
              'bg-white/5 border-transparent text-muted-foreground',
              n.status === 'locked' && 'opacity-40 pointer-events-none',
            )}
          >
            {n.status === 'locked' ? <Lock className="w-3 h-3 inline -mt-0.5 mr-1" /> : null}
            {String(n.chapterNumber).padStart(2, '0')}
          </LinkNext>
        ))}
      </div>

      <div className="flex-1 min-h-0 grid lg:grid-cols-[1fr_340px]">
        {/* Editor */}
        <div className="overflow-y-auto">
          <div className="max-w-3xl mx-auto px-8 py-10">
            <div className="flex items-start justify-between mb-8 flex-wrap gap-4">
              <div>
                <div className="label text-primary mb-2">
                  CHAPTER {String(chapterNum).padStart(2, '0')} · {Math.round(wordCount).toLocaleString()} / {targetWords.toLocaleString()} words
                </div>
                <h1 className="font-serif text-4xl font-semibold leading-tight mb-2">{title}</h1>
                {outline?.summary && <p className="text-sm text-muted-foreground max-w-xl">{outline.summary}</p>}
              </div>
            </div>

            {/* Draft Recovery Banner */}
            {recoveredDraft && !isApproved && (
              <div className="mb-6 p-4 rounded-lg border border-amber-500/40 bg-amber-500/10 text-sm space-y-3" role="alert">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold text-amber-200">Unsaved draft recovered</div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        A local recovery copy from {formatSaveTime(recoveredDraft.savedAt)} ({recoveredDraft.wordCount.toLocaleString()} words) differs from the saved server version ({(chapter?.wordCount || 0).toLocaleString()} words).
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowCompareRecovery(v => !v)}
                      className="btn-outline text-xs px-2.5 py-1"
                    >
                      <Eye className="w-3 h-3" /> {showCompareRecovery ? 'Hide comparison' : 'Compare'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRestoreDraft()}
                      className="btn-primary text-xs px-2.5 py-1"
                    >
                      <RotateCcw className="w-3 h-3" /> Restore draft
                    </button>
                    <button
                      type="button"
                      onClick={handleDiscardDraft}
                      className="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
                    >
                      Discard
                    </button>
                  </div>
                </div>
                {showCompareRecovery && (
                  <div className="grid md:grid-cols-2 gap-3 pt-2 border-t border-amber-500/20 text-xs">
                    <div className="p-3 rounded bg-[hsl(var(--surface))] border border-border">
                      <div className="font-mono text-[10px] uppercase text-amber-400 mb-1">Recovered local draft ({recoveredDraft.wordCount} words)</div>
                      <p className="text-muted-foreground whitespace-pre-wrap max-h-40 overflow-y-auto">{recoveredDraft.plainText || '(empty)'}</p>
                    </div>
                    <div className="p-3 rounded bg-[hsl(var(--surface))] border border-border">
                      <div className="font-mono text-[10px] uppercase text-emerald-400 mb-1">Server version ({chapter?.wordCount || 0} words)</div>
                      <p className="text-muted-foreground whitespace-pre-wrap max-h-40 overflow-y-auto">{chapter?.plainText || extractPlainTextFromDoc(initialContent) || '(empty)'}</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Conflict Banner */}
            {autosaveState.status === 'conflict' && (
              <div className="mb-6 p-4 rounded-lg border border-destructive/40 bg-destructive/10 text-sm flex items-center justify-between gap-3 flex-wrap" role="alert">
                <div>
                  <div className="font-semibold text-destructive">Conflicting edit detected</div>
                  <p className="text-xs text-muted-foreground">
                    A newer version exists on the server. Your conflicting draft was preserved in Version History so nothing is lost.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => router.refresh()} className="btn-outline text-xs px-3 py-1.5">
                    Reload latest server version
                  </button>
                </div>
              </div>
            )}

            {/* Version Preview Modal/Banner */}
            {previewVersion && (
              <div className="mb-6 p-4 rounded-lg border border-primary/40 bg-[hsl(var(--surface-secondary))] text-sm space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">
                    Previewing Version v{previewVersion.versionNum} ({previewVersion.wordCount} words · {previewVersion.note || previewVersion.revisionType || 'snapshot'})
                  </div>
                  <div className="flex items-center gap-2">
                    {!isApproved && (
                      <button
                        type="button"
                        onClick={() => restoreRevisionMutation.mutate(previewVersion.id)}
                        disabled={restoreRevisionMutation.isPending}
                        className="btn-primary text-xs px-2.5 py-1"
                      >
                        <RotateCcw className="w-3 h-3" /> Restore this version
                      </button>
                    )}
                    <button type="button" onClick={() => setPreviewVersion(null)} className="text-muted-foreground hover:text-foreground p-1">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground whitespace-pre-wrap max-h-48 overflow-y-auto p-3 rounded bg-[hsl(var(--surface))] border border-border">
                  {previewVersion.plainText || '(empty)'}
                </p>
              </div>
            )}

            {/* Toolbar */}
            {editor && !isLocked && chapter && (
              <div className="sticky top-0 z-10 -mx-2 px-2 py-2 mb-4 rounded-lg bg-[hsl(var(--surface-secondary))]/90 backdrop-blur flex flex-wrap items-center gap-1 border border-border">
                <ToolBtn label="Bold" onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')}><Bold className="w-4 h-4" /></ToolBtn>
                <ToolBtn label="Italic" onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')}><Italic className="w-4 h-4" /></ToolBtn>
                <ToolBtn label="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')}><UnderlineIcon className="w-4 h-4" /></ToolBtn>
                <ToolBtn label="Highlight" onClick={() => editor.chain().focus().toggleHighlight().run()} active={editor.isActive('highlight')}><Highlighter className="w-4 h-4" /></ToolBtn>
                <Divider />
                <ToolBtn label="Heading" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })}><Heading1 className="w-4 h-4" /></ToolBtn>
                <ToolBtn label="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')}><List className="w-4 h-4" /></ToolBtn>
                <ToolBtn label="Quote" onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')}><Quote className="w-4 h-4" /></ToolBtn>
                <ToolBtn label="Align left" onClick={() => editor.chain().focus().setTextAlign('left').run()} active={editor.isActive({ textAlign: 'left' })}><AlignLeft className="w-4 h-4" /></ToolBtn>
                <ToolBtn label="Align center" onClick={() => editor.chain().focus().setTextAlign('center').run()} active={editor.isActive({ textAlign: 'center' })}><AlignCenter className="w-4 h-4" /></ToolBtn>
                <Divider />
                <ToolBtn label="Undo" onClick={() => editor.chain().focus().undo().run()}><Undo2 className="w-4 h-4" /></ToolBtn>
                <ToolBtn label="Redo" onClick={() => editor.chain().focus().redo().run()}><Redo2 className="w-4 h-4" /></ToolBtn>

                <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground pr-1" aria-live="polite">
                  {autosaveState.status === 'unsaved' && (
                    <span className="flex items-center gap-1.5 text-amber-400">
                      <span className="w-2 h-2 rounded-full bg-amber-400" /> Unsaved changes
                    </span>
                  )}
                  {autosaveState.status === 'saving' && (
                    <span className="flex items-center gap-1.5 text-primary">
                      <Loader2 className="w-3 h-3 animate-spin" /> Saving…
                    </span>
                  )}
                  {autosaveState.status === 'saved' && (
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Save className="w-3 h-3 text-emerald-400" /> Saved {formatSaveTime(autosaveState.lastSavedAt)}
                    </span>
                  )}
                  {autosaveState.status === 'error' && (
                    <span className="flex items-center gap-1.5 text-destructive">
                      <AlertTriangle className="w-3 h-3" /> Save failed
                      <button
                        type="button"
                        onClick={() => void handleManualSave()}
                        className="underline hover:text-foreground ml-1"
                      >
                        Retry
                      </button>
                    </span>
                  )}
                  {!isApproved && (
                    <button
                      type="button"
                      onClick={() => void handleManualSave()}
                      disabled={autosaveState.status === 'saving'}
                      className="btn-outline text-xs px-2.5 py-1 ml-1"
                      title="Save chapter checkpoint (Ctrl+S)"
                    >
                      <Save className="w-3 h-3" /> Save
                    </button>
                  )}
                </div>
              </div>
            )}

            {(readingGeneration || isWritingJob) ? (
              <section className="surface p-6 md:p-10" aria-label="Chapter generation">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-6" role="status">
                  {isWritingJob ? <><Loader2 className="w-4 h-4 animate-spin" /> Writing your chapter…</> : 'Chapter complete'}
                </div>
                <div className="whitespace-pre-wrap font-serif text-lg leading-relaxed">
                  {isWritingJob ? (generationJob?.result?.partialText || 'Preparing your story context…') : chapter?.plainText || generationJob?.result?.partialText || 'Loading your saved chapter…'}
                </div>
                {!isWritingJob && chapter && (
                  <div className="flex flex-wrap gap-3 mt-8 border-t border-border pt-6">
                    <button className="btn-outline" onClick={() => { setReadingGeneration(false); editor?.commands.setContent(initialContent); }}>Open in editor</button>
                    {navigation?.some((n: any) => n.chapterNumber > chapterNum) && (
                      <button className="btn-primary" onClick={() => approve.mutate()} disabled={approve.isPending || isDemoContent}>
                        {approve.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Continue next chapter
                      </button>
                    )}
                    <p className="text-xs text-muted-foreground w-full">Continuing approves this chapter and unlocks the next one.</p>
                  </div>
                )}
              </section>
            ) : !chapter ? (
              <div className="surface p-12 text-center">
                <Wand2 className="w-10 h-10 text-primary/60 mx-auto mb-4" />
                <h3 className="font-serif text-2xl mb-2">Ready to write</h3>
                <p className="text-sm text-muted-foreground max-w-md mx-auto mb-6">
                  NovelForge will generate the first draft of this chapter, drawing on the Story Bible, outline, and previous chapter summary. You&apos;ll be able to edit every word.
                </p>
                <button className="btn-primary" onClick={() => generateChapter.mutate()} disabled={generateChapter.isPending || isWritingJob || isLocked}>
                  {(generateChapter.isPending || isWritingJob) ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> {isWritingJob ? `Writing… ${generationJob?.progress ? `${generationJob.progress}%` : ''}` : 'Generating…'}</>
                  ) : (
                    <><Sparkles className="w-4 h-4" /> Generate Chapter {chapterNum}</>
                  )}
                </button>
                {isLocked && <p className="text-xs text-amber-400 mt-4"><Lock className="w-3 h-3 inline mr-1" />Previous chapter must be approved first.</p>}
              </div>
            ) : isLocked ? (
              <div className="surface p-12 text-center">
                <Lock className="w-10 h-10 text-muted-foreground mx-auto mb-4" />
                <h3 className="font-serif text-xl mb-2">Locked</h3>
                <p className="text-sm text-muted-foreground">Approve the previous chapter to unlock this one.</p>
              </div>
            ) : (
              <div className="prose-editor">
                <EditorContent editor={editor} />
              </div>
            )}

            {isDemoContent && (
              <p className="text-xs text-amber-400 mb-4">
                This is an older demo draft, not an AI-generated chapter. Use Regenerate to replace it with a real story from an available configured provider.
              </p>
            )}

            {chapter && isApproved && (
              <div className="surface-secondary p-4 rounded-lg mb-6 text-sm text-muted-foreground">
                Approved — this chapter is read-only and its summary has been added to story memory.
              </div>
            )}

            {chapter && !isLocked && !isApproved && !readingGeneration && !isWritingJob && (
              <div className="mt-10 pt-6 border-t border-border flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span>{Math.round(wordCount).toLocaleString()} words</span>
                  <span>·</span>
                  <span>{pages} estimated pages</span>
                  <span>·</span>
                  <span>{progress}% of target</span>
                </div>
                <div className="flex items-center gap-2">
                  <button className="btn-outline" onClick={() => generateChapter.mutate()} disabled={generateChapter.isPending || isWritingJob}>
                    <RefreshCw className={cn('w-4 h-4', (generateChapter.isPending || isWritingJob) && 'animate-spin')} />
                    {chapter?.status === 'edited' ? 'Regenerate (replaces edits)' : 'Regenerate'}
                  </button>
                  <button className="btn-primary" onClick={() => approve.mutate()} disabled={approve.isPending || wordCount < 100}>
                    {approve.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve & continue
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* AI & Revision History Panel */}
        <aside className="border-l border-border bg-[hsl(var(--surface))] overflow-y-auto p-5 space-y-5 hidden lg:block">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-primary/15 text-primary flex items-center justify-center"><Sparkles className="w-4 h-4" /></div>
              <div>
                <div className="font-semibold text-sm">Forge Assistant</div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Context-aware partner</div>
              </div>
            </div>
            {aiState !== 'idle' && (
              <div className="typing-indicator text-xs text-primary mt-2">Thinking<span /><span /><span /></div>
            )}
          </div>

          <div className="surface-secondary p-3 rounded-lg">
            <div className="text-[10px] font-semibold tracking-widest text-emerald-400 mb-1">CONTEXT LOADED</div>
            <p className="text-xs text-muted-foreground">Outline · Story Bible {previousSummary ? '· Previous chapter' : ''} · {memories.length} memories</p>
          </div>

          {chapter && !isApproved && (
            <div className="space-y-2">
              <div className="label mb-2">Editor actions</div>
              {[
                { k: 'continue', label: 'Continue scene', icon: Zap },
                { k: 'rewrite', label: 'Rewrite selection', icon: RefreshCw },
                { k: 'expand', label: 'Expand', icon: Wand2 },
                { k: 'shorten', label: 'Shorten', icon: Wand2 },
                { k: 'improve', label: 'Improve prose', icon: Sparkles },
                { k: 'dialogue', label: 'Improve dialogue', icon: MessageSquare },
              ].map(b => (
                <button
                  key={b.k}
                  onClick={() => aiAction.mutate(b.k)}
                  disabled={aiState !== 'idle' || !editor}
                  className="w-full text-left p-2.5 rounded-lg text-sm border border-border bg-[hsl(var(--surface-secondary))] hover:border-primary/40 hover:text-primary transition flex items-center gap-2"
                >
                  <b.icon className="w-4 h-4" /> {b.label}
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
              <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: `${progress}%` }} />
            </div>
            <div className="flex justify-between text-[11px] text-muted-foreground mt-1.5 font-mono">
              <span>{Math.round(wordCount).toLocaleString()} words</span>
              <span>{targetWords.toLocaleString()} goal</span>
            </div>
          </div>

          {chapter && (
            <div className="pt-2 border-t border-border">
              <div className="flex items-center justify-between mb-2">
                <span className="label flex items-center gap-1.5">
                  <HistoryIcon className="w-3.5 h-3.5" /> Revision History
                </span>
                <span className="text-[10px] font-mono text-muted-foreground">rev {autosaveState.revision}</span>
              </div>
              {versions.length === 0 ? (
                <p className="text-xs text-muted-foreground">No saved snapshots yet.</p>
              ) : (
                <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                  {versions.slice(0, 12).map((v: any) => (
                    <div key={v.id} className="p-2 rounded-md border border-border bg-[hsl(var(--surface-secondary))] text-xs flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          v{v.versionNum} · {v.wordCount}w
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate">
                          {v.note || v.revisionType || 'snapshot'} · {formatSaveTime(v.createdAt)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => void inspectVersion(v.id)}
                          className="p-1 text-muted-foreground hover:text-foreground"
                          title="Preview version"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        {!isApproved && (
                          <button
                            type="button"
                            onClick={() => restoreRevisionMutation.mutate(v.id)}
                            disabled={restoreRevisionMutation.isPending}
                            className="p-1 text-muted-foreground hover:text-primary"
                            title="Restore version"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {/* Bottom nav */}
      <div className="border-t border-border px-6 py-3 flex items-center justify-between bg-[hsl(var(--surface-secondary))]">
        {prevNav ? (
          <LinkNext href={`/novels/${novel.id}/write/${prevNav.chapterNumber}`} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="w-4 h-4" /> Chapter {prevNav.chapterNumber}
          </LinkNext>
        ) : <span />}
        {nextNav ? (
          <LinkNext href={`/novels/${novel.id}/write/${nextNav.chapterNumber}`} className="flex items-center gap-2 text-sm text-primary font-medium">
            Chapter {nextNav.chapterNumber} <ChevronRight className="w-4 h-4" />
          </LinkNext>
        ) : chapter?.status === 'approved' ? (
          <LinkNext href={`/novels/${novel.id}/consistency`} className="flex items-center gap-2 text-sm text-primary font-medium">
            Run consistency check <ChevronRight className="w-4 h-4" />
          </LinkNext>
        ) : <span />}
      </div>
    </div>
  );
}

function ToolBtn({ children, onClick, active, label }: { children: React.ReactNode; onClick: () => void; active?: boolean; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn('w-8 h-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-white/5 transition', active && 'bg-primary/15 text-primary')}
    >
      {children}
    </button>
  );
}
function Divider() { return <div className="w-px h-5 bg-border mx-1" />; }
