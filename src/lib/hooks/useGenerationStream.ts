'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * One job-specific SSE subscription.
 *
 * The browser's EventSource reconnects automatically and sends
 * `Last-Event-ID`; the server replays persisted events from that cursor, so a
 * brief disconnect does not lose updates. This hook never cancels the
 * generation — unmounting only closes the local notification channel, which is
 * why navigating away or refreshing cannot stop background work.
 *
 * Incremental content (`generation_content`) is applied in order and
 * de-duplicated by its monotonic `sequence`, so a reconnect that replays
 * already-seen chunks never duplicates text.
 */

export interface GenerationView {
  id: string;
  novelId: string;
  novelTitle?: string | null;
  chapterId?: string | null;
  chapterTitle?: string | null;
  chapterNumber?: number | null;
  taskType?: string | null;
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
  /** Which engine executed the job (persisted on the job row). */
  engine?: 'universal' | 'legacy';
}

export const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;

export function isTerminalStatus(status?: string | null): boolean {
  return !!status && (TERMINAL_STATUSES as readonly string[]).includes(status);
}

type Handler = (generation: GenerationView) => void;

/** The event names the server can emit. */
const EVENT_TYPES = [
  'generation_snapshot',
  'generation_queued',
  'generation_started',
  'generation_progress',
  'generation_content',
  'generation_completed',
  'generation_failed',
  'generation_cancelled',
] as const;

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

    // Streamed text accumulated from content events, and the highest sequence
    // applied so far. Both live for the lifetime of one subscription; the
    // authoritative copy is always the persisted text the server replays.
    let streamed = '';
    let lastSequence = -1;
    let latest: GenerationView | null = null;

    const emit = (patch: Partial<GenerationView>) => {
      if (closed) return;
      latest = { ...(latest ?? ({ id: jobId } as GenerationView)), ...patch, id: jobId };
      setGeneration(latest);
      callbacks.current.onUpdate?.(latest);
      if (isTerminalStatus(latest.status) && !terminalFired.current) {
        terminalFired.current = true;
        callbacks.current.onTerminal?.(latest);
      }
    };

    const apply = (data: any) => {
      if (!data || closed) return;
      const incoming = data as Partial<GenerationView> & { partialText?: string | null };
      // A snapshot/replay carries the durable accumulated text: trust it over
      // local accumulation (it is the copy that survived any disconnect).
      if (typeof incoming.partialText === 'string' && incoming.partialText.length >= streamed.length) {
        streamed = incoming.partialText;
      }
      emit({ ...(incoming as GenerationView), partialText: streamed || incoming.partialText || null });
    };

    const applyContent = (data: any) => {
      if (!data || closed) return;
      const sequence = typeof data.sequence === 'number' ? data.sequence : lastSequence + 1;
      if (sequence <= lastSequence) return; // replayed chunk already applied
      lastSequence = sequence;
      const delta = typeof data.delta === 'string'
        ? data.delta
        : typeof data.content === 'string'
          ? data.content
          : '';
      if (!delta) return;
      streamed += delta;
      emit({
        status: (data.status as GenerationView['status']) ?? latest?.status ?? 'PROCESSING',
        currentStage: data.stage ?? 'STREAMING_CONTENT',
        currentStageLabel: data.stageLabel ?? 'Streaming content',
        partialText: streamed,
      });
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
      for (const type of EVENT_TYPES) {
        source.addEventListener(type, event => {
          try {
            const data = JSON.parse((event as MessageEvent).data);
            if (type === 'generation_content') applyContent(data);
            else apply(data);
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
