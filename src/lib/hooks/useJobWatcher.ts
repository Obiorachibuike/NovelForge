'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelUsage } from '@/lib/ai/model-provenance';

export interface WatchedJob {
  id: string;
  status: 'queued' | 'processing' | 'awaiting_review' | 'completed' | 'failed' | 'cancelled';
  error?: string | null;
  errorCode?: string | null;
  retryable?: number | boolean | null;
  result?: { partialText?: string; [key: string]: unknown } | null;
  progress?: number | null;
  requestedModel?: string | null;
  actualModel?: string | null;
  provider?: string | null;
  fallbackCount?: number | null;
  modelUsages?: ModelUsage[] | null;
}

export interface JobWatcherOptions {
  /** Poll interval in ms (default 1500). */
  intervalMs?: number;
  /** Give up after this many polls (default 120 ≈ 3 minutes). */
  maxPolls?: number;
  /** Restore the most recent job and resume polling if it is still running. */
  initialJob?: WatchedJob | null;
  onComplete?: (job: WatchedJob) => void;
  onFail?: (job: WatchedJob) => void;
}

/**
 * Follows a durable generation job through GET /api/jobs/[jobId].
 *
 * Background work is asynchronous, so the UI must never assume the work
 * finished when the POST returns: it reports queued → running → done/failed
 * from the persisted job row, which also survives a page refresh.
 */
export function useJobWatcher(options: JobWatcherOptions = {}) {
  const { intervalMs = 1500, maxPolls = 120, initialJob, onComplete, onFail } = options;
  const [job, setJob] = useState<WatchedJob | null>(initialJob ?? null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Invalidates in-flight requests when switching jobs or unmounting.
  const watchVersion = useRef(0);
  const callbacks = useRef({ onComplete, onFail });
  callbacks.current = { onComplete, onFail };

  const stop = useCallback(() => {
    watchVersion.current += 1;
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => stop, [stop]);

  const watch = useCallback((jobId: string, initial?: Partial<WatchedJob>) => {
    stop();
    const version = watchVersion.current;
    // Show the requested model immediately, before the first poll completes.
    setJob({ id: jobId, status: 'queued', ...initial });
    let polls = 0;
    let inFlight = false;
    const tick = async () => {
      if (version !== watchVersion.current || inFlight) return;
      inFlight = true;
      polls++;
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
        if (res.ok) {
          const data = (await res.json()) as WatchedJob;
          if (version !== watchVersion.current) return;
          setJob(data);
          if (data.status === 'completed' || data.status === 'awaiting_review') {
            stop();
            callbacks.current.onComplete?.(data);
            return;
          }
          if (data.status === 'failed' || data.status === 'cancelled') {
            stop();
            callbacks.current.onFail?.(data);
            return;
          }
        }
      } catch {
        // Transient network failure: keep polling until the budget runs out.
      } finally {
        inFlight = false;
      }
      if (version === watchVersion.current && polls >= maxPolls) stop();
    };
    timer.current = setInterval(tick, intervalMs);
    void tick();
  }, [intervalMs, maxPolls, stop]);

  const resumeId = initialJob && (initialJob.status === 'queued' || initialJob.status === 'processing') ? initialJob.id : null;
  useEffect(() => {
    if (resumeId) watch(resumeId, initialJob ?? undefined);
    // A new id or active state is enough to resume; the snapshot's object
    // identity can change on a server-component refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId, watch]);

  return { job, watch, stop };
}
