import { requireJob, requireUser } from '@/lib/db/ownership';
import { errorResponse, HttpError } from '@/lib/api/http';
import {
  decodeEventCursor,
  formatHeartbeat,
  formatSseFrame,
  listGenerationEvents,
  parseEventPayload,
  type EventCursor,
  type GenerationEventRow,
} from '@/lib/jobs/events';
import {
  generationSnapshot,
  getGenerationForUser,
  serializeGeneration,
} from '@/lib/jobs/generation-jobs';
import {
  GenerationEventType,
  GenerationStatus,
  isTerminalPublicStatus,
  stageLabel,
  toPublicStatus,
} from '@/lib/jobs/job-types';

// --- UNIVERSAL GENERATION ENGINE ---
// The stream itself is engine-agnostic: every producer (universal engine, the
// chapter service, an image job) persists the same `generation_events` rows and
// every event is replayed from there. The engine an individual job belongs to is
// read from its *persisted* payload marker, never guessed from a handler lookup,
// so a legacy job can never be misrouted and a built-in universal type works
// even when no custom handler is registered.
import { GenerationRegistry } from '@/lib/ai/generation/generation-registry';
import { isUniversalEngineJob } from '@/lib/ai/generation/generation-persistence';
import { isGenerationType } from '@/lib/ai/generation/generation-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/generations/[jobId]/events — Server-Sent Events.
 *
 * - authenticated (`requireUser`) and owner-scoped (`requireJob`);
 * - every update is a persisted `generation_events` row, so a reconnect with
 *   `Last-Event-ID` replays what was missed, across processes;
 * - heartbeats keep proxies from closing idle connections;
 * - the stream closes after a terminal event; the browser reconnects
 *   automatically after transient failures.
 */

const POLL_MS = Math.max(250, Number(process.env.SSE_POLL_MS || 1000));
const HEARTBEAT_MS = Math.max(5000, Number(process.env.SSE_HEARTBEAT_MS || 15000));
function maxConnectionsPerUser(): number {
  return Math.max(1, Number(process.env.SSE_MAX_CONNECTIONS_PER_USER || 6));
}

/**
 * Per-process guard against a tab farm opening unbounded streams. A dropped
 * process simply starts the count at zero again; this is a resource guard, not
 * a security boundary (ownership is enforced by `requireJob`).
 */
const openStreams = new Map<string, number>();

function acquireStreamSlot(userId: string): boolean {
  const current = openStreams.get(userId) ?? 0;
  if (current >= maxConnectionsPerUser()) return false;
  openStreams.set(userId, current + 1);
  return true;
}

function releaseStreamSlot(userId: string): void {
  const current = openStreams.get(userId) ?? 0;
  if (current <= 1) openStreams.delete(userId);
  else openStreams.set(userId, current - 1);
}

function frameForEvent(row: GenerationEventRow, eventId: string): string {
  const payload = parseEventPayload(row);
  return formatSseFrame({
    event: row.type,
    id: eventId,
    data: {
      ...payload,
      jobId: row.jobId,
      novelId: row.novelId ?? null,
      chapterId: row.chapterId ?? null,
      status: row.status ?? payload.status ?? null,
      stage: row.stage ?? payload.stage ?? null,
      stageLabel: stageLabel(row.stage ?? (payload.stage as string | undefined) ?? null),
      at: row.createdAt,
    },
  });
}

function isTerminalEvent(row: GenerationEventRow): boolean {
  return [GenerationEventType.COMPLETED, GenerationEventType.FAILED, GenerationEventType.CANCELLED].includes(
    row.type as any,
  );
}

export async function GET(req: Request, ctx: { params: { jobId: string } }) {
  try {
    const user = await requireUser();
    const owned = await requireJob(ctx.params.jobId, user.id);
    const generation = getGenerationForUser(user.id, owned.id);
    if (!generation) throw new HttpError(404, 'Generation not found', 'generation_not_found');

    // Engine ownership comes from the durable row (payload marker). The
    // registry is only consulted to report whether a *custom* handler overrides
    // the built-in path for this type.
    const engine = isUniversalEngineJob(generation) ? 'universal' : 'legacy';
    const customHandler =
      isGenerationType(generation.taskType) && GenerationRegistry.hasHandler(generation.taskType);

    const url = new URL(req.url);
    if (!acquireStreamSlot(user.id)) {
      throw new HttpError(429, 'Too many open generation event streams.', 'sse_connection_limit');
    }

    const lastEventId =
      req.headers.get('last-event-id') || url.searchParams.get('lastEventId') || null;
    const after = decodeEventCursor(lastEventId);

    const encoder = new TextEncoder();
    let cursor: EventCursor | null = after;
    let closed = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let heartbeatAt = Date.now();
    let sawTerminal = false;
    let released = false;
    const sent = new Set<string>();

    const releaseSlot = () => {
      if (released) return;
      released = true;
      releaseStreamSlot(user.id);
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const push = (frame: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            cleanup();
          }
        };

        const cleanup = () => {
          releaseSlot();
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          timer = null;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };

        const sendRow = (row: GenerationEventRow) => {
          if (sent.has(row.id)) return;
          sent.add(row.id);
          const eventId = String(row.seq);
          cursor = row.seq;
          push(frameForEvent(row, eventId));
          if (isTerminalEvent(row)) sawTerminal = true;
        };

        // A retry hint lets the browser reconnect quickly after a network blip.
        push('retry: 3000\n\n');

        const snapshot = {
          ...generationSnapshot(generation),
          engine,
          customHandler,
        };
        push(formatSseFrame({ event: GenerationEventType.SNAPSHOT, data: snapshot }));

        // Replay everything the client missed. Batches avoid unbounded memory
        // while still delivering a long history in order.
        let replay = listGenerationEvents(generation.id, { after: cursor, limit: 200 });
        while (replay.length > 0) {
          for (const row of replay) sendRow(row);
          if (replay.length < 200) break;
          replay = listGenerationEvents(generation.id, { after: cursor, limit: 200 });
        }

        const snapshotStatus = toPublicStatus(generation.status);

        if (sawTerminal || isTerminalPublicStatus(snapshotStatus)) {
          // If there is no persisted terminal row (e.g. history was pruned),
          // still tell the client how the job ended.
          if (!sawTerminal) {
            const type =
              snapshotStatus === GenerationStatus.COMPLETED
                ? GenerationEventType.COMPLETED
                : snapshotStatus === GenerationStatus.FAILED
                  ? GenerationEventType.FAILED
                  : GenerationEventType.CANCELLED;
            push(formatSseFrame({ event: type, data: { ...serializeGeneration(generation), status: snapshotStatus } }));
          }
          cleanup();
          return;
        }

        const tick = () => {
          if (closed) return;
          if (req.signal.aborted) {
            cleanup();
            return;
          }
          try {
            const events = listGenerationEvents(generation.id, { after: cursor, limit: 100 });
            for (const row of events) sendRow(row);

            if (events.some(isTerminalEvent)) {
              cleanup();
              return;
            }

            // If the job reached a terminal state but its event row is missing,
            // read the durable job once and close honestly.
            if (Date.now() - heartbeatAt >= HEARTBEAT_MS) {
              heartbeatAt = Date.now();
              const current = getGenerationForUser(user.id, generation.id);
              if (current) {
                const status = toPublicStatus(current.status);
                if (isTerminalPublicStatus(status) && events.length === 0) {
                  push(
                    formatSseFrame({
                      event:
                        status === GenerationStatus.COMPLETED
                          ? GenerationEventType.COMPLETED
                          : status === GenerationStatus.FAILED
                            ? GenerationEventType.FAILED
                            : GenerationEventType.CANCELLED,
                      data: serializeGeneration(current),
                    }),
                  );
                  cleanup();
                  return;
                }
              }
              push(formatHeartbeat());
            }
          } catch (err) {
            // A transient database error must not kill the stream: the next
            // tick retries. A permanent failure closes rather than spinning.
            console.error('[generations/sse] poll failed', err);
          }
        };

        timer = setInterval(tick, POLL_MS);
        if (typeof timer.unref === 'function') timer.unref();

        req.signal.addEventListener('abort', cleanup);
      },
      cancel() {
        releaseSlot();
        closed = true;
        if (timer) clearInterval(timer);
        timer = null;
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
