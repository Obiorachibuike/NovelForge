'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface WatchedJob {
  id: string;
  status: 'queued' | 'processing' | 'awaiting_review' | 'completed' | 'failed' | 'cancelled';
  error?: string | null;
  errorCode?: string | null;
  retryable?: number | null;
  result?: string | null;
  progress?: number | null;
}

export interface JobWatcherOptions {
  /** Poll interval in ms (default 1500). */
  intervalMs?: number;
  /** Give up after this many polls (default 120 ≈ 3 minutes). */
  maxPolls?: number;
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
  const { intervalMs = 1500, maxPolls = 120, onComplete, onFail } = options;
  const [job, setJob] = useState<WatchedJob | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const callbacks = useRef({ onComplete, onFail });
  callbacks.current = { onComplete, onFail };

  const stop = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => stop, [stop]);

  const watch = useCallback((jobId: string) => {
    stop();
    let polls = 0;
    const tick = async () => {
      polls++;
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
        if (res.ok) {
          const data = (await res.json()) as WatchedJob;
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
      }
      if (polls >= maxPolls) stop();
    };
    void tick();
    timer.current = setInterval(tick, intervalMs);
  }, [intervalMs, maxPolls, stop]);

  return { job, watch, stop };
}
