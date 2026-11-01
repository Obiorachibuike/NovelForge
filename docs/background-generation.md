# Universal background AI generation and streaming

NovelForge runs AI content generation asynchronously. Chapter generation and universal text-generation jobs share the durable PostgreSQL job store, dedicated Node.js worker, event log and SSE transport. Text providers stream real output incrementally; each chunk is persisted and replayable. Authors can navigate anywhere in the application — or close the tab — while jobs continue.

No Redis, Django, Celery, RabbitMQ or Procrastinate is involved.

```
NEXT.JS APP (process A)
  │  POST /api/generations
  ▼
PostgreSQL  ── generation_jobs (source of truth)
  │            generation_events (SSE replay)
  │            notifications
  │
  ├── pg-boss queue: novelforge.chapter-generation
  │        │
  │        ▼
  │   NODE.JS WORKER (process B, npm run worker)
  │        │
  │        ▼
  │   existing AI providers (Agnes AI → Hugging Face → OpenAI)
  │        │
  │        ▼
  │   chapter saved + events + notification
  │
  └── SSE: GET /api/generations/[jobId]/events
           │
           ▼
      Global generation indicator (root layout)
```

## Why two processes

A Next.js serverless function is frozen once its response is sent. Starting
generation inline (or from `setImmediate`) stops the moment the platform
freezes the function, and it certainly stops when the browser closes. The
worker is a persistent Node.js process that has no relationship to any request
or browser tab. Deploy it to any host that supports long-lived processes
(Fly.io, Railway, Render, a container, a VM); the Next.js app can remain on
Vercel as long as both share `DATABASE_URL`.

## Durable state

`generation_jobs` is the source of truth. pg-boss carries only a wake-up
containing the row id (`{ dbJobId }`), in a `stately` queue with
`singletonKey = chapter-generation:<id>` so pg-boss also refuses duplicate
queued/active entries for the same generation.

| Table | Purpose |
| --- | --- |
| `generation_jobs` | status, stage, attempts, errors, timestamps, model provenance |
| `generation_events` | append-only SSE events with a per-job `seq` for `Last-Event-ID` replay |
| `notifications` | persistent notification centre entries (`dedupeKey` prevents duplicates) |
| `chapters.generationStatus` | `NOT_STARTED / QUEUED / PROCESSING / COMPLETED / FAILED / CANCELLED` |

If pg-boss is unavailable, the row stays `queued` and the worker's database
sweep picks it up. If a worker crashes mid-job, `recoverStaleJobs` re-queues
the row after `QUEUE_STALE_JOB_MS`. If the browser is closed, nothing changes.

## Lifecycle

1. `POST /api/generations` authenticates the user, validates novel/chapter
   ownership, checks the sequential-writing gate, counts active jobs, inserts
   the job row and returns `202 { jobId, status: "QUEUED" }`.
2. The chapter is marked `QUEUED`; a `generation_queued` event is persisted.
3. The worker claims the row with a compare-and-set `UPDATE` (a second
   delivery cannot execute it), marks it `PROCESSING` and emits
   `generation_started`.
4. The handler runs the existing `runChapterGeneration` implementation:
   novel context, previous chapters, outline, Story Bible memories and the
   existing prompt builder/provider chain.
5. Real stage transitions are persisted and streamed
   (`generation_progress`).
6. On success the chapter is written in a transaction, marked `COMPLETED`,
   a `generation_completed` event and notification are created.
7. Failures are classified (permanent vs retryable), retried with exponential
   backoff (2s, 4s, 8s … capped at 60s) up to `maxAttempts`, then marked
   `FAILED`.

### Stages

`PREPARING_CHAPTER → LOADING_NOVEL_CONTEXT → PREPARING_AI_PROMPT →
CONNECTING_TO_AI_PROVIDER → GENERATING_CHAPTER_CONTENT →
PROCESSING_AI_RESPONSE → VALIDATING_CHAPTER → SAVING_CHAPTER → COMPLETED`

Only stages the worker actually reaches are stored. Providers do not expose a
real completion percentage, so `progressPercentage` stays `NULL` for chapter
generation and the UI renders an indeterminate indicator. No percentage is
invented.

## API

| Method | Path | Result |
| --- | --- | --- |
| `POST` | `/api/generations` | `202` with `jobId`, `status`, `eventsUrl`, `cancelUrl`, `retryUrl` |
| `GET` | `/api/generations` | own history (`limit`), plus `activeGenerations` |
| `GET` | `/api/generations/[jobId]` | owner-only details |
| `GET` | `/api/generations/[jobId]/events` | SSE stream (snapshot, replay, progress, heartbeat) |
| `POST` | `/api/generations/[jobId]/cancel` | cooperative cancellation (`409` once finished) |
| `POST` | `/api/generations/[jobId]/retry` | retry `FAILED`/`CANCELLED` only |
| `GET` | `/api/notifications` | notification centre + unread count |
| `PATCH` | `/api/notifications/[id]` | mark one read |
| `POST` | `/api/notifications/read-all` | mark all read |

Legacy endpoints (`POST /api/novels/[id]/chapters`, `/api/jobs/[jobId]`) keep
working and share the same durable queue.

### SSE details

- Cookie-authenticated; ownership is checked before the stream opens.
- Every event has `id: <seq>`; EventSource reconnects with `Last-Event-ID` and
  the server replays `seq > last`.
- `generation_snapshot` is sent first so a freshly opened panel renders
  immediately.
- A comment heartbeat is sent every `SSE_HEARTBEAT_MS` (15s).
- Terminal events close the stream; EventSource reconnects on transient errors.
- At most `SSE_MAX_CONNECTIONS_PER_USER` (default 6) streams per user per
  process.

## Concurrency and limits

- `WORKER_CONCURRENCY` (default 2) controls simultaneous jobs per worker.
- Running jobs write `lastHeartbeatAt` every `GENERATION_HEARTBEAT_MS`
  (default 20s). Stale recovery compares that heartbeat (not the original
  claim time) with `QUEUE_STALE_JOB_MS`, so a long generation is never
  mistaken for a dead worker and executed twice.
- `GENERATION_MAX_ACTIVE_PER_USER` (default 3) allows work across several
  novels; `GENERATION_MAX_ACTIVE_PER_NOVEL` (default 1) preserves narrative
  continuity and the existing sequential-writing gate.
- Queue prioritisation uses `generation_jobs.priority` (higher first) and the
  matching pg-boss `priority` option. Retries keep the original priority.
- Duplicate prevention is enforced twice: the partial unique index
  `ux_jobs_active_idempotency` on `chapter:<novelId>:<chapterNumber>` and the
  pg-boss `singletonKey`.

## Cancellation and idempotency

Cancellation writes `status=cancelled` and `cancelRequestedAt`, aborts the
provider request where the provider supports `AbortSignal`, and is re-checked
inside the chapter-saving transaction so prose is never overwritten after a
cancel. A completed job cannot be cancelled.

Chapter writes preserve existing content when generation fails or is cancelled.
A retry reuses the same job row and refuses to start if a newer active job
exists for the same chapter, so a chapter cannot be generated twice.

## Local development and tests

SQLite cannot host pg-boss. In development/tests (`DATABASE_URL=file:…`) the
same `generation_jobs` table is drained by the worker poller; `QUEUE_PROVIDER=database`
can force this mode explicitly. The pg-boss transport is exercised with a
deterministic fake in `tests/generation/background-generation.test.ts`.

```bash
# terminal 1
npm run dev
# terminal 2
npm run worker:dev
```

## Operational notes

- Run `npm run db:migrate` before starting either process; migration `0013`
  creates the event/notification tables and generation columns.
- pg-boss creates and migrates its own `pgboss` schema on first start. The
  database user needs `CREATE` on the database (or pre-create the schema).
- Graceful shutdown (`SIGTERM`/`SIGINT`) stops pg-boss, waits up to
  `WORKER_SHUTDOWN_MS` for in-flight jobs, and closes the database pool.
- Health: `GET /api/health` reports `queue.transport`, whether pg-boss is
  enabled, and job counts.

### Known limitations

- pg-boss itself was not exercised against a live PostgreSQL server in this
  environment (no PostgreSQL available); its producer/consumer paths are
  covered by a fake and the durable DB paths are fully tested.
- Rate limiting is per process (existing NovelForge behaviour); use a gateway
  or sticky sessions when running many web instances.
- SSE connections are held on the web process; a serverless host with short
  function limits will cut them, so run the app on a persistent Node.js
  host for long streams.

## Universal text generation

Any feature can submit a text task to `POST /api/generations/content` with an authenticated user's `novelId`, a registered `generationType`, prompt, optional provider model and optional target metadata. The endpoint validates novel ownership and returns `202` immediately. It enqueues the shared `ai-content` handler; the dedicated worker calls the existing provider-agnostic `generateTextDetailed` layer, including Agnes AI and Hugging Face streaming support. It does not introduce a second provider stack.

The worker's `onContent` callback persists the accumulated partial text in the durable job result and publishes `generation_content` events containing both the new `chunk` and current `partialText`. The global generation provider subscribes to every active job, restores active jobs after refresh, and the activity dock displays a live excerpt while the author is elsewhere in the app. Chapter generation uses the same event contract through its existing provider callback. Structured JSON tasks that cannot safely expose partial JSON should continue to publish stage/progress events and reveal validated output when complete.

Supported generation types include novel titles/descriptions/summaries, story ideas/outlines, chapter outlines, pages/scenes, character profiles/backstories/relationships, worldbuilding/locations/cultures/history, blurbs, author bios, marketing copy, rewriting, expansion, summarization, shortening, proofreading and humanization. Add new types through the API allowlist and call the same endpoint; do not create another queue or worker.
