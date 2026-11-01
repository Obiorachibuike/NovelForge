'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  useGenerationStream,
  type GenerationView,
} from '@/lib/hooks/useGenerationStream';
import {
  GenerationContext,
  type GenerationContextValue,
  type NotificationView,
} from './GenerationContext';
import { GenerationDock } from './GenerationDock';

/**
 * Global generation state.
 *
 * Mounted in the root layout, so it stays alive across route navigation. It
 * restores active jobs after a refresh by asking the server
 * (`GET /api/generations`), then re-subscribes to each job's persistent SSE
 * stream. No React unmount ever cancels background work — the worker owns it.
 */

function isActive(status?: string | null) {
  return status === 'QUEUED' || status === 'PROCESSING';
}

export function GenerationProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [generations, setGenerations] = useState<GenerationView[]>([]);
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [connectedJobIds, setConnectedJobIds] = useState<string[]>([]);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const terminalHandled = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applyGeneration = useCallback((incoming: GenerationView) => {
    setGenerations(prev => {
      const index = prev.findIndex(g => g.id === incoming.id);
      if (index === -1) return [incoming, ...prev].slice(0, 50);
      const merged = { ...prev[index], ...incoming };
      const next = [...prev];
      next[index] = merged;
      return next;
    });
  }, []);

  const handleTerminal = useCallback(
    (job: GenerationView) => {
      const key = `${job.id}:${job.status}`;
      if (terminalHandled.current.has(key)) return;
      terminalHandled.current.add(key);
      applyGeneration(job);

      if (job.status === 'COMPLETED') {
        toast.success(job.chapterTitle || job.title ? `${job.chapterTitle || job.title} is ready` : `${job.generationType || 'AI content'} is ready`, {
          description: 'Generated in the background and saved. Open it to read or edit.',
          action: job.chapterId
            ? {
                label: 'View chapter',
                onClick: () => router.push(`/novels/${job.novelId}/write/${job.chapterId}`),
              }
            : undefined,
        });
      } else if (job.status === 'FAILED') {
        toast.error(`${job.generationType || 'AI'} generation failed`, {
          description: job.errorMessage || 'You can retry from the generation panel.',
        });
      } else if (job.status === 'CANCELLED') {
        toast.message('Generation cancelled', {
          description: job.chapterId ? 'Existing chapter content was preserved.' : 'Any partial generated content remains available in activity.',
        });
      }

      // Content is saved by the worker; refresh server components so the
      // editor and chapter list show it without a manual browser refresh.
      router.refresh();
      void refreshNotifications();
      // Reconcile with the durable rows shortly afterwards.
      window.setTimeout(() => { void refresh(); }, 750);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyGeneration, router],
  );

  const refreshNotifications = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?limit=20', { cache: 'no-store' });
      if (res.status === 401) return;
      if (!res.ok) return;
      const data = await res.json();
      if (!mounted.current) return;
      setNotifications(Array.isArray(data.notifications) ? data.notifications : []);
      setUnreadCount(Number(data.unreadCount || 0));
    } catch {
      /* offline: keep the last known notifications */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/generations?limit=30', { cache: 'no-store' });
      if (res.status === 401) {
        setAuthenticated(false);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      if (!mounted.current) return;
      setAuthenticated(true);
      const rows: GenerationView[] = Array.isArray(data.generations) ? data.generations : [];
      // The history query is bounded. Active jobs are returned separately so a
      // long-running generation cannot vanish from the indicator on refresh.
      const active: GenerationView[] = Array.isArray(data.activeGenerations)
        ? data.activeGenerations
        : [];
      setGenerations(prev => {
        const byId = new Map(rows.map(r => [r.id, r]));
        for (const job of active) {
          byId.set(job.id, { ...(byId.get(job.id) ?? {}), ...job } as GenerationView);
        }
        for (const existing of prev) {
          const fresh = byId.get(existing.id);
          if (fresh) {
            // Keep a newer streamed status if the list raced the SSE event.
            byId.set(existing.id, { ...existing, ...fresh });
          } else if (isActive(existing.status)) {
            byId.set(existing.id, existing);
          }
        }
        return Array.from(byId.values())
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
          .slice(0, 50);
      });
    } catch {
      /* keep the last known state */
    }
    void refreshNotifications();
  }, [refreshNotifications]);

  useEffect(() => {
    void refresh();

    const onFocus = () => { void refresh(); };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const onExternalStart = (event: Event) => {
      const detail = (event as CustomEvent<GenerationView>).detail;
      if (detail?.id) {
        setAuthenticated(true);
        applyGeneration(detail);
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('novelforge:generation-started', onExternalStart as EventListener);

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && authenticated !== false) {
        void refresh();
      }
    }, 20_000);

    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('novelforge:generation-started', onExternalStart as EventListener);
      window.clearInterval(interval);
    };
  }, [applyGeneration, authenticated, refresh]);

  const trackGeneration = useCallback(
    (generation: GenerationView) => {
      if (!generation?.id) return;
      setAuthenticated(true);
      applyGeneration(generation);
      void refreshNotifications();
    },
    [applyGeneration, refreshNotifications],
  );

  const cancelGeneration = useCallback(
    async (jobId: string) => {
      try {
        const res = await fetch(`/api/generations/${jobId}/cancel`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not cancel generation');
        if (data.generation) applyGeneration(data.generation);
        toast.message('Generation cancelled');
        void refresh();
      } catch (err: any) {
        toast.error(err?.message || 'Could not cancel generation');
      }
    },
    [applyGeneration, refresh],
  );

  const retryGeneration = useCallback(
    async (jobId: string) => {
      try {
        const res = await fetch(`/api/generations/${jobId}/retry`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not retry generation');
        if (data.generation) applyGeneration(data.generation);
        terminalHandled.current.delete(`${jobId}:FAILED`);
        terminalHandled.current.delete(`${jobId}:CANCELLED`);
        toast.success('Generation retried');
        void refresh();
      } catch (err: any) {
        toast.error(err?.message || 'Could not retry generation');
      }
    },
    [applyGeneration, refresh],
  );

  const markNotificationRead = useCallback(async (id: string) => {
    setNotifications(prev => prev.map(n => (n.id === id ? { ...n, isRead: true } : n)));
    setUnreadCount(prev => Math.max(0, prev - 1));
    try {
      const res = await fetch(`/api/notifications/${id}`, { method: 'PATCH' });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (typeof data.unreadCount === 'number') setUnreadCount(data.unreadCount);
      }
    } catch {
      /* best effort */
    }
  }, []);

  const markAllNotificationsRead = useCallback(async () => {
    setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
    setUnreadCount(0);
    try {
      await fetch('/api/notifications/read-all', { method: 'POST' });
    } catch {
      /* best effort */
    }
  }, []);

  const activeGenerations = useMemo(
    () => generations.filter(g => isActive(g.status)),
    [generations],
  );

  const value = useMemo<GenerationContextValue>(
    () => ({
      generations,
      activeGenerations,
      notifications,
      unreadCount,
      connectedJobIds,
      trackGeneration,
      refresh,
      cancelGeneration,
      retryGeneration,
      markNotificationRead,
      markAllNotificationsRead,
    }),
    [
      generations,
      activeGenerations,
      notifications,
      unreadCount,
      connectedJobIds,
      trackGeneration,
      refresh,
      cancelGeneration,
      retryGeneration,
      markNotificationRead,
      markAllNotificationsRead,
    ],
  );

  const handleConnectedChange = useCallback(
    (connected: boolean, id: string) => {
      setConnectedJobIds(prev =>
        connected
          ? prev.includes(id)
            ? prev
            : [...prev, id]
          : prev.filter(x => x !== id),
      );
    },
    [],
  );

  return (
    <GenerationContext.Provider value={value}>
      {children}
      {/* One subscription per *active* job; independent of which page is open. */}
      {activeGenerations.slice(0, 10).map(generation => (
        <GenerationSubscription
          key={generation.id}
          jobId={generation.id}
          onUpdate={applyGeneration}
          onTerminal={handleTerminal}
          onConnectedChange={handleConnectedChange}
        />
      ))}
      <GenerationDock />
    </GenerationContext.Provider>
  );
}

function GenerationSubscription({
  jobId,
  onUpdate,
  onTerminal,
  onConnectedChange,
}: {
  jobId: string;
  onUpdate: (generation: GenerationView) => void;
  onTerminal: (generation: GenerationView) => void;
  onConnectedChange: (connected: boolean, id: string) => void;
}) {
  const { connected } = useGenerationStream(jobId, { onUpdate, onTerminal });
  const callback = useRef(onConnectedChange);
  callback.current = onConnectedChange;
  useEffect(() => {
    callback.current(connected, jobId);
    return () => callback.current(false, jobId);
  }, [connected, jobId]);
  return null;
}
