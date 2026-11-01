'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Ban,
  Bell,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useGeneration } from './GenerationContext';
import { GenerationStatusBadge, generationStatusLabel } from './GenerationStatusBadge';
import type { GenerationView } from '@/lib/hooks/useGenerationStream';

/**
 * Global AI generation indicator.
 *
 * Rendered at the application root, so it stays mounted while the author moves
 * between the dashboard, novel library, editors, settings and account pages.
 * It is a *view* of durable server state: closing it, minimising it or
 * navigating never stops the worker.
 */

function chapterHref(job: GenerationView): string | null {
  if (!job.novelId) return null;
  if (job.chapterId) return `/novels/${job.novelId}/write/${job.chapterId}`;
  if (job.chapterNumber) return `/novels/${job.novelId}/write/${job.chapterNumber}`;
  return `/novels/${job.novelId}`;
}

function isActive(job: GenerationView) {
  return job.status === 'QUEUED' || job.status === 'PROCESSING';
}

export function GenerationDock() {
  const {
    generations,
    activeGenerations,
    notifications,
    unreadCount,
    cancelGeneration,
    retryGeneration,
    markNotificationRead,
    markAllNotificationsRead,
  } = useGeneration();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'activity' | 'notifications'>('activity');

  const hasAnything = activeGenerations.length > 0 || unreadCount > 0 || generations.length > 0;
  if (!hasAnything) return null;

  if (!open) {
    const active = activeGenerations.length;
    return (
      <div className="fixed bottom-4 right-4 z-50 print:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            'flex items-center gap-2 rounded-full border shadow-lg backdrop-blur px-4 py-2.5 text-sm transition',
            active
              ? 'border-primary/40 bg-[hsl(var(--surface))]/95 text-primary'
              : 'border-border bg-[hsl(var(--surface))]/95 text-muted-foreground hover:text-foreground',
          )}
          aria-label={
            active
              ? `${active} background AI generation${active === 1 ? '' : 's'} in progress. Open the AI generation panel.`
              : 'Open the AI generation activity panel'
          }
        >
          {active ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="w-4 h-4" aria-hidden="true" />
          )}
          <span className="font-medium">
            {active ? `AI generating ${active > 1 ? `(${active})` : ''}` : 'AI activity'}
          </span>
          {unreadCount > 0 && (
            <span className="ml-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold px-1.5 py-0.5">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>
      </div>
    );
  }

  const recent = generations.filter(g => !isActive(g)).slice(0, 8);

  return (
    <div
      className="fixed z-50 bottom-3 left-3 right-3 sm:left-auto sm:right-5 sm:bottom-5 sm:w-[380px] print:hidden"
      role="region"
      aria-label="AI generation activity"
    >
      <div className="rounded-xl border border-border bg-[hsl(var(--surface))]/98 shadow-2xl backdrop-blur overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <div className="w-7 h-7 rounded-lg bg-primary/15 text-primary flex items-center justify-center">
            <Sparkles className="w-4 h-4" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-semibold tracking-[0.18em] text-primary">AI GENERATION</div>
            <div className="text-xs text-muted-foreground truncate">
              {activeGenerations.length
                ? `${activeGenerations.length} job${activeGenerations.length === 1 ? '' : 's'} running in the background`
                : 'Background activity'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5"
            aria-label="Minimise AI generation panel"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-1 px-3 pt-2" role="tablist" aria-label="Generation panel tabs">
          <TabButton active={tab === 'activity'} onClick={() => setTab('activity')}>
            Activity
            {activeGenerations.length > 0 && (
              <span className="ml-1.5 chip-primary text-[9px] px-1.5">{activeGenerations.length}</span>
            )}
          </TabButton>
          <TabButton active={tab === 'notifications'} onClick={() => setTab('notifications')}>
            <Bell className="w-3.5 h-3.5" aria-hidden="true" />
            Notifications
            {unreadCount > 0 && (
              <span className="ml-1.5 rounded-full bg-primary text-primary-foreground text-[9px] font-bold px-1.5 py-0.5">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </TabButton>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-3 space-y-2">
          {tab === 'activity' ? (
            <>
              {activeGenerations.length === 0 && recent.length === 0 && (
                <p className="text-xs text-muted-foreground p-3">No generation activity yet.</p>
              )}
              {activeGenerations.map(job => (
                <JobRow
                  key={job.id}
                  job={job}
                  onCancel={() => void cancelGeneration(job.id)}
                  onRetry={() => void retryGeneration(job.id)}
                />
              ))}
              {recent.length > 0 && (
                <div className="pt-2">
                  <div className="label px-1 mb-1.5">RECENT</div>
                  <div className="space-y-1.5">
                    {recent.map(job => (
                      <JobRow
                        key={job.id}
                        job={job}
                        compact
                        onCancel={() => void cancelGeneration(job.id)}
                        onRetry={() => void retryGeneration(job.id)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="label">NOTIFICATION CENTRE</span>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={() => void markAllNotificationsRead()}
                    className="text-[11px] text-primary hover:underline"
                  >
                    Mark all read
                  </button>
                )}
              </div>
              {notifications.length === 0 ? (
                <p className="text-xs text-muted-foreground p-3">No notifications yet.</p>
              ) : (
                notifications.map(n => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      if (!n.isRead) void markNotificationRead(n.id);
                      if (n.href) router.push(n.href);
                    }}
                    className={cn(
                      'w-full text-left rounded-lg border p-2.5 transition',
                      n.isRead
                        ? 'border-border bg-transparent text-muted-foreground hover:border-primary/30'
                        : 'border-primary/30 bg-primary/5 hover:bg-primary/10',
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0">
                        {n.kind === 'generation_completed' ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        ) : n.kind === 'generation_failed' ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
                        ) : n.kind === 'generation_cancelled' ? (
                          <Ban className="w-3.5 h-3.5 text-muted-foreground" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5 text-primary" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-foreground truncate">{n.title}</span>
                        <span className="block text-[11px] text-muted-foreground line-clamp-2">{n.message}</span>
                        <span className="block text-[10px] text-muted-foreground/70 mt-1">
                          {formatRelative(n.createdAt)}
                        </span>
                      </span>
                    </div>
                  </button>
                ))
              )}
            </>
          )}
        </div>

        <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
          Generation runs on the server — you can keep using NovelForge and close this panel.
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition',
        active ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function JobRow({
  job,
  compact,
  onCancel,
  onRetry,
}: {
  job: GenerationView;
  compact?: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const active = isActive(job);
  const href = chapterHref(job);
  const title = job.chapterTitle || job.title || (job.chapterNumber ? `Chapter ${job.chapterNumber}` : formatGenerationType(job.generationType || job.taskType || 'AI content'));
  return (
    <div
      className={cn(
        'rounded-lg border p-2.5',
        active ? 'border-primary/30 bg-primary/5' : 'border-border bg-[hsl(var(--surface-secondary))]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium truncate">{title}</div>
          <div className="text-[10px] text-muted-foreground truncate">
            {job.novelTitle || 'Novel'}
            {job.chapterNumber ? ` · Chapter ${job.chapterNumber}` : job.generationType ? ` · ${formatGenerationType(job.generationType)}` : ''}
          </div>
        </div>
        <GenerationStatusBadge status={job.status} />
      </div>

      {active && (
        <>
          <div className="text-[11px] text-primary mt-2 flex items-center gap-1.5" role="status" aria-live="polite">
            <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
            {job.currentStageLabel || 'Queued — waiting for the worker'}
          </div>
          {/*
            Providers do not expose real generation progress, so this is an
            indeterminate indicator, never a fabricated percentage.
          */}
          <div
            className="mt-2 h-1 rounded-full bg-white/5 overflow-hidden"
            role="progressbar"
            aria-valuetext={job.currentStageLabel || generationStatusLabel(job.status)}
          >
            <div className="h-full w-1/3 bg-gradient-to-r from-indigo-500 to-violet-500 animate-pulse" />
          </div>
        </>
      )}

      {active && job.partialText && (
        <div className="mt-2 max-h-24 overflow-hidden rounded-md border border-border/60 bg-black/10 p-2 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap" aria-live="polite">
          {job.partialText.slice(-700)}
        </div>
      )}

      {!active && job.status === 'FAILED' && (
        <p className="text-[11px] text-destructive mt-2 line-clamp-2" title={job.errorMessage || undefined}>
          {job.errorMessage || 'Generation failed.'}
        </p>
      )}

      {!compact && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
          {href && (
            <Link
              href={href}
              className="text-[11px] inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:border-primary/40 hover:text-primary"
            >
              <ExternalLink className="w-3 h-3" aria-hidden="true" /> {job.chapterId ? 'View chapter' : 'View novel'}
            </Link>
          )}
          {active && (
            <button
              type="button"
              onClick={onCancel}
              className="text-[11px] inline-flex items-center gap-1 rounded-md border border-destructive/30 text-destructive px-2 py-1 hover:bg-destructive/10"
            >
              <X className="w-3 h-3" aria-hidden="true" /> Cancel
            </button>
          )}
          {job.status === 'FAILED' && (
            <button
              type="button"
              onClick={onRetry}
              className="text-[11px] inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:border-primary/40 hover:text-primary"
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" /> Retry
            </button>
          )}
        </div>
      )}
      {!active && (
        <div className="text-[10px] text-muted-foreground mt-1.5">You can keep using NovelForge.</div>
      )}
    </div>
  );
}

function formatGenerationType(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function formatRelative(iso?: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
