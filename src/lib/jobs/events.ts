import 'server-only';
import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import {
  GenerationEventType,
  type GenerationStatus,
  type GenerationStage,
} from './job-types';

/**
 * Durable generation events.
 *
 * Server-Sent Events must survive reconnects and must work when the SSE route
 * (Next.js) and the producer (the worker process) are different Node processes.
 * An in-memory emitter cannot do either, so every event is a row in
 * `generation_events` and the SSE route replays rows after the client's
 * `Last-Event-ID`.
 */

export interface GenerationEventRow {
  id: string;
  seq: number;
  jobId: string;
  userId: string;
  novelId?: string | null;
  chapterId?: string | null;
  type: string;
  status?: string | null;
  stage?: string | null;
  payload?: string | null;
  createdAt: string;
}

export interface PublishGenerationEventInput {
  jobId: string;
  userId: string;
  novelId?: string | null;
  chapterId?: string | null;
  type: GenerationEventType | string;
  status?: GenerationStatus | string | null;
  stage?: GenerationStage | string | null;
  data?: Record<string, unknown> | null;
}

/**
 * Persists one event. Deliberately best-effort at call sites: an event write
 * must never turn a successful chapter generation into a failed job.
 */
export function publishGenerationEvent(input: PublishGenerationEventInput): GenerationEventRow {
  const db = getDb();
  const now = new Date().toISOString();

  // A per-job sequence makes replay deterministic even when several events are
  // written in the same millisecond (worker stages + API cancellation). The
  // unique index on (jobId, seq) turns a rare cross-process race into a retry
  // instead of a mis-ordered stream.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const row = db.transaction(() => {
        const next = (
          db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM generation_events WHERE jobId=?')
            .get(input.jobId) as { next: number }
        ).next;
        const inserted: GenerationEventRow = {
          id: nanoid(),
          seq: Number(next),
          jobId: input.jobId,
          userId: input.userId,
          novelId: input.novelId ?? null,
          chapterId: input.chapterId ?? null,
          type: input.type,
          status: (input.status as string | null | undefined) ?? null,
          stage: (input.stage as string | null | undefined) ?? null,
          payload: input.data ? JSON.stringify(input.data) : null,
          createdAt: now,
        };
        db.prepare(
          `INSERT INTO generation_events (id,seq,jobId,userId,novelId,chapterId,type,status,stage,payload,createdAt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          inserted.id,
          inserted.seq,
          inserted.jobId,
          inserted.userId,
          inserted.novelId,
          inserted.chapterId,
          inserted.type,
          inserted.status,
          inserted.stage,
          inserted.payload,
          inserted.createdAt,
        );
        return inserted;
      })();
      return row;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = /unique|duplicate key|constraint/i.test(message);
      if (!retryable || attempt === 5) throw err;
    }
  }
  throw new Error('Could not persist generation event');
}

export function safePublishGenerationEvent(input: PublishGenerationEventInput): void {
  try {
    publishGenerationEvent(input);
  } catch (err) {
    console.error('[generation-events] failed to persist event', input.type, err);
  }
}

/** The seq of the last event the client has seen. */
export type EventCursor = number;

/** SSE `id:` value: the job-local event sequence. */
export function encodeEventCursor(event: Pick<GenerationEventRow, 'seq'>): string {
  return String(event.seq);
}

export function decodeEventCursor(raw: string | null | undefined): EventCursor | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seq = Number(trimmed);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  return seq;
}

/**
 * Returns events for one job, oldest first, after an optional cursor.
 *
 * Same-millisecond events are included when they share the cursor timestamp;
 * the caller drops the exact id it has already seen. That is deliberately
 * prefer-duplicate over lose-an-event.
 */
export function listGenerationEvents(
  jobId: string,
  options: { after?: EventCursor | null; limit?: number } = {},
): GenerationEventRow[] {
  const db = getDb();
  const limit = Math.min(200, Math.max(1, options.limit ?? 100));
  const after = options.after;
  if (after === null || after === undefined) {
    return db
      .prepare('SELECT * FROM generation_events WHERE jobId=? ORDER BY seq ASC LIMIT ?')
      .all(jobId, limit) as GenerationEventRow[];
  }
  return db
    .prepare('SELECT * FROM generation_events WHERE jobId=? AND seq > ? ORDER BY seq ASC LIMIT ?')
    .all(jobId, after, limit) as GenerationEventRow[];
}

export function parseEventPayload(row: GenerationEventRow): Record<string, unknown> {
  if (!row.payload) return {};
  try {
    const parsed = JSON.parse(row.payload);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Formats one SSE frame. Newlines in data are split per the SSE spec. */
export function formatSseFrame(input: {
  event?: string;
  id?: string;
  data: unknown;
  retryMs?: number;
}): string {
  const lines: string[] = [];
  if (input.event) lines.push(`event: ${input.event}`);
  if (input.id) lines.push(`id: ${input.id}`);
  if (input.retryMs) lines.push(`retry: ${input.retryMs}`);
  const json = typeof input.data === 'string' ? input.data : JSON.stringify(input.data);
  for (const line of json.split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

export function formatHeartbeat(comment = 'keep-alive'): string {
  return `: ${comment} ${new Date().toISOString()}\n\n`;
}
