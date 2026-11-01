'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * One job-specific SSE subscription.
 *
 * The browser's EventSource reconnects automatically and sends
 * `Last-Event-ID`; the server replays persisted events from that cursor, so a
 * brief disconnect does not lose updates. This hook never cancels the
 * generation — unmounting only closes the local notification channel.
 */

export interface GenerationView {
  id: string;
  novelId: string;
  novelTitle?: string | null;
  chapterId?: string | null;
  chapterTitle?: string | null;
  chapterNumber?: number | null;
  status: 'NOT_STARTED' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  progressPercentage?: number | null;
  indeterminate?: boolean;
  currentStage?: string | null;
  currentStageLabel?: string | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  canCancel?: boolean;
  canRetry?: boolean;
  retryCount?: number;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  eventsUrl?: string;
  /** Real partial text emitted by the provider, when it streams one. */
  partialText?: string | null;
}

export const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;

export function isTerminalStatus(status?: string | null): boolean {
  return !!status && (TERMINAL_STATUSES as readonly string[]).includes(status);
}

type Handler = (generation: GenerationView) => void;

export function useGenerationStream(
  jobId: string | null | undefined,
  handlers: {
    onUpdate?: Handler;
    onTerminal?: Handler;
  } = {},
) {
  const [connected, setConnected] = useState(false);
  const [generation, setGeneration] = useState<GenerationView | null>(null);
  const callbacks = useRef(handlers);
  callbacks.current = handlers;
  const terminalFired = useRef(false);

  useEffect(() => {
    if (!jobId) return;
    terminalFired.current = false;
    let source: EventSource | null = null;
    let closed = false;
    let errors = 0;

    const apply = (data: any) => {
      if (!data || closed) return;
      const next: GenerationView = {
        ...(data as GenerationView),
        id: jobId,
      };
      setGeneration(next);
      callbacks.current.onUpdate?.(next);
      if (isTerminalStatus(next.status) && !terminalFired.current) {
        terminalFired.current = true;
        callbacks.current.onTerminal?.(next);
      }
    };

    try {
      source = new EventSource(`/api/generations/${jobId}/events`);
      source.onopen = () => {
        errors = 0;
        setConnected(true);
      };
      source.onerror = () => {
        // EventSource retries automatically; report the channel state without
        // closing the stream ourselves (that would defeat reconnection).
        setConnected(false);
        // A 401/404 is answered with an error on every attempt. Give up after
        // several consecutive failures instead of retrying forever; the job
        // itself is unaffected because it lives in the database.
        errors += 1;
        if (errors >= 10) source?.close();
      };
      const types = [
        'generation_snapshot',
        'generation_queued',
        'generation_started',
        'generation_progress',
        'generation_completed',
        'generation_failed',
        'generation_cancelled',
      ];
      for (const type of types) {
        source.addEventListener(type, event => {
          try {
            apply(JSON.parse((event as MessageEvent).data));
          } catch {
            /* ignore malformed frame */
          }
        });
      }
    } catch {
      setConnected(false);
    }

    return () => {
      closed = true;
      source?.close();
    };
  }, [jobId]);

  return { generation, connected };
}
