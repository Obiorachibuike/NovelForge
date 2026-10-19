'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Loader2,
  FileText,
  File,
  Download,
  Check,
  BookOpen,
  FileType,
  FileCode,
  AlertTriangle,
  Archive,
  Upload,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useJobWatcher } from '@/lib/hooks/useJobWatcher';
import { listUnsavedDraftsForNovel, type DraftRecoveryEntry } from '@/lib/editor/draft-recovery';

const FORMATS = [
  { id: 'pdf', label: 'PDF', desc: 'Print-ready manuscript', icon: File },
  { id: 'docx', label: 'DOCX', desc: 'Editable Word document', icon: FileText },
  { id: 'epub', label: 'EPUB', desc: 'E-reader format', icon: BookOpen },
  { id: 'txt', label: 'TXT', desc: 'Plain text', icon: FileType },
  { id: 'markdown', label: 'Markdown', desc: 'MD for further editing', icon: FileCode },
] as const;

export default function ExportView({ novel, settings, exports }: any) {
  const router = useRouter();
  const [format, setFormat] = useState<string>('docx');
  const [unsavedDrafts, setUnsavedDrafts] = useState<DraftRecoveryEntry[]>([]);
  const [restoring, setRestoring] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { job, watch } = useJobWatcher({
    onComplete: () => {
      toast.success(`${format.toUpperCase()} export ready for download.`);
      router.refresh();
    },
    onFail: (j) => {
      toast.error(j.error || 'Export failed');
      router.refresh();
    },
  });
  const isBusy = job?.status === 'queued' || job?.status === 'processing';

  const [opts, setOpts] = useState({
    pageSize: settings.pageSize || 'letter',
    fontFamily: settings.fontFamily || 'serif',
    fontSize: settings.fontSize || 12,
    lineSpacing: settings.lineSpacing || 1.6,
    includeToc: !!settings.includeToc,
    includeFrontMatter: !!settings.includeFrontMatter,
  });

  useEffect(() => {
    setUnsavedDrafts(listUnsavedDraftsForNovel(novel.id));
  }, [novel.id]);

  const mut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/novels/${novel.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, options: opts }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Export failed');
      return data;
    },
    onSuccess: (data) => {
      toast.message(`Building ${format.toUpperCase()} export...`);
      if (data?.jobId) watch(data.jobId);
    },
    onError: (e: any) => toast.error(e.message),
  });

  async function handleRestoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!window.confirm(`Restore "${file.name}" into "${novel.title}"? Current novel data will be replaced if validation succeeds.`)) {
      return;
    }
    setRestoring(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('Selected file is not valid JSON.');
      }
      const res = await fetch(`/api/novels/${novel.id}/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Backup restore failed');
      toast.success(`Restored "${data.title}" (${data.chaptersRestored} chapters, ${data.versionsRestored} revisions).`);
      router.refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Backup restore failed');
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <div className="label text-primary mb-2">STAGE 10 · EXPORT & BACKUP</div>
        <h1 className="font-serif text-3xl font-semibold">Your story, ready for the world.</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Export a formatted manuscript or download a complete integrity-verified project backup.
        </p>
      </div>

      {unsavedDrafts.length > 0 && (
        <div
          role="alert"
          className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 flex items-start gap-3"
        >
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-medium text-amber-300">
              Unsaved local draft edits detected ({unsavedDrafts.length}{' '}
              {unsavedDrafts.length === 1 ? 'chapter' : 'chapters'})
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Exports are built from persisted database chapters. Open the chapter editor to save or discard your local browser recovery drafts first:
            </p>
            <div className="flex flex-wrap gap-2 mt-2">
              {unsavedDrafts.map(d => (
                <Link
                  key={d.chapterId}
                  href={`/novels/${novel.id}/write/${d.chapterId}`}
                  className="text-xs px-2.5 py-1 rounded bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 transition"
                >
                  Open Chapter {d.chapterNumber} ({d.wordCount} words)
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-[1fr_360px] gap-6">
        <div>
          <div className="label mb-3">Choose format</div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
            {FORMATS.map(f => (
              <button
                key={f.id}
                onClick={() => setFormat(f.id)}
                className={cn(
                  'surface p-4 text-left transition card-hover',
                  format === f.id && 'border-primary shadow-[0_0_0_1px_hsl(var(--primary))]',
                )}
              >
                <div className="flex items-center justify-between mb-2">
                  <f.icon className={cn('w-6 h-6', format === f.id ? 'text-primary' : 'text-muted-foreground')} />
                  {format === f.id && <Check className="w-4 h-4 text-primary" />}
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
                <select className="input" value={opts.pageSize} onChange={e => setOpts({ ...opts, pageSize: e.target.value })}>
                  {['letter', 'a4', 'a5', 'trade'].map(s => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Font family">
                <select className="input" value={opts.fontFamily} onChange={e => setOpts({ ...opts, fontFamily: e.target.value })}>
                  <option value="serif">Serif (default)</option>
                  <option value="sans">Sans-serif</option>
                  <option value="mono">Mono</option>
                </select>
              </Field>
              <Field label="Font size (pt)">
                <input type="number" className="input" min={8} max={24} value={opts.fontSize} onChange={e => setOpts({ ...opts, fontSize: +e.target.value })} />
              </Field>
              <Field label="Line spacing">
                <input type="number" step="0.1" min={1} max={3} className="input" value={opts.lineSpacing} onChange={e => setOpts({ ...opts, lineSpacing: +e.target.value })} />
              </Field>
            </div>
            <div className="flex flex-col gap-2">
              <Toggle label="Include table of contents" value={opts.includeToc} onChange={v => setOpts({ ...opts, includeToc: v })} />
              <Toggle label="Include front matter (title page, copyright)" value={opts.includeFrontMatter} onChange={v => setOpts({ ...opts, includeFrontMatter: v })} />
            </div>
          </div>

          <button className="btn-primary w-full mt-6" onClick={() => mut.mutate()} disabled={mut.isPending || isBusy}>
            {mut.isPending || isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Prepare export
          </button>
        </div>

        <div className="space-y-6 h-fit">
          <div className="surface p-5">
            <h3 className="font-serif text-lg font-semibold mb-3">Previous exports</h3>
            {exports.length === 0 ? (
              <p className="text-sm text-muted-foreground">No exports yet.</p>
            ) : (
              <div className="space-y-2">
                {exports.map((e: any) => (
                  <a
                    key={e.id}
                    href={e.fileUrl || '#'}
                    target={e.fileUrl ? '_blank' : undefined}
                    rel="noopener"
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-[hsl(var(--surface-secondary))] transition"
                  >
                    <div className="w-9 h-9 rounded-md bg-primary/15 text-primary flex items-center justify-center">
                      <Download className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm uppercase">{e.format}</div>
                      <div className="text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</div>
                    </div>
                    {e.status === 'completed' ? (
                      <span className="chip chip-success">Ready</span>
                    ) : e.status === 'failed' ? (
                      <span className="chip chip-error">Failed</span>
                    ) : (
                      <span className="chip chip-primary">
                        <Loader2 className="w-3 h-3 animate-spin" />
                      </span>
                    )}
                  </a>
                ))}
              </div>
            )}
          </div>

          <div className="surface p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Archive className="w-4 h-4 text-primary" />
              <h3 className="font-serif text-lg font-semibold">Project backup & restore</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              Download a full SHA-256 verified JSON snapshot of this novel (metadata, Story Bible, characters, outline, chapters, revision history, and covers) or restore from a backup file.
            </p>
            <div className="flex flex-col gap-2 pt-1">
              <a
                href={`/api/novels/${novel.id}/backup?download=1`}
                className="btn-secondary w-full justify-center text-xs"
              >
                <Download className="w-3.5 h-3.5" /> Download full backup (.json)
              </a>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleRestoreFile}
              />
              <button
                type="button"
                disabled={restoring}
                onClick={() => fileInputRef.current?.click()}
                className="btn-ghost w-full justify-center text-xs border border-[hsl(var(--border))]"
              >
                {restoring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                Restore from backup (.json)
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex items-center justify-between w-full p-2 rounded-md hover:bg-[hsl(var(--surface-secondary))]"
    >
      <span className="text-sm">{label}</span>
      <span className={cn('w-10 h-5 rounded-full relative transition', value ? 'bg-primary' : 'bg-white/10')}>
        <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white transition', value ? 'left-5' : 'left-0.5')} />
      </span>
    </button>
  );
}
