# Background AI chapter generation — implementation report

**Date:** 2026-11-01
**Branch:** `arena/1a4960e9-novelforge`
**Base:** `f2eaead` (`main`)

## 1. What was built

Chapter generation is now a durable background job. `POST /api/generations`
returns `202` with a job id in milliseconds; the work runs in a dedicated
Node.js worker process, and the author can navigate anywhere, refresh, close the
tab, or restart the app while it continues.

No Django, Python, Celery, Redis, RabbitMQ or Procrastinate was introduced. The
existing Next.js App Router backend, PostgreSQL architecture, ORM/database
facade, AI providers (Agnes AI → Hugging Face → OpenAI) and Cloudinary cover
storage are reused.

### Runtime shape

```
Browser ──POST /api/generations──► Next.js (process A)
                                      │ insert generation_jobs row (source of truth)
                                      │ pg-boss.send({ dbJobId })
                                      ▼
                                  PostgreSQL
                                      │ pg-boss queue novelforge.chapter-generation
                                      ▼
                              Worker (process B, npm run worker)
                                      │ CAS-claim the row
                                      │ runChapterGeneration (existing logic)
                                      ▼
                              chapters + generation_events + notifications
                                      │
Browser ◄── SSE /api/generations/[jobId]/events ◄── persisted seq-ordered events
```

Key properties:

- **Database is the source of truth.** pg-boss carries only the wake-up
  (`{ dbJobId }`); a lost/duplicated message can never duplicate generation.
- **Atomic claim** (`UPDATE … WHERE status='queued'`) makes double delivery,
  multi-worker sweeps and API retries safe.
- **Heartbeats** (`GENERATION_HEARTBEAT_MS`, 20s) mean a genuinely long chapter
  is never mistaken for a dead worker; stale recovery compares
  `COALESCE(lastHeartbeatAt, claimedAt)` with `QUEUE_STALE_JOB_MS`.
- **Crash-safe completion:** if the chapter was already saved by the same job
  before the worker died, the retry finishes bookkeeping instead of calling the
  AI again.
- **No fabricated progress.** `progressPercentage` stays `NULL` for chapter
  jobs; only real stages reached by the worker are persisted and streamed.

## 2. Files

### Created

| File | Purpose |
| --- | --- |
| `src/lib/jobs/job-types.ts` | Lifecycle/stage/event vocabulary, `toPublicStatus`, `stageLabel`, row types |
| `src/lib/jobs/events.ts` | Durable event log with per-job `seq`, SSE frame/heartbeat formatting, `Last-Event-ID` decoding |
| `src/lib/jobs/notifications.ts` | Persistent notifications, per-attempt dedupe, read state |
| `src/lib/jobs/queues.ts` | Queue name/transport, pg-boss retry/retention options, worker concurrency |
| `src/lib/jobs/boss.ts` | Lazy pg-boss singleton, producer, consumer registration, graceful stop, test seam |
| `src/lib/jobs/generation-jobs.ts` | Application service: create/list/get/cancel/retry/serialise/snapshot |
| `src/lib/jobs/worker.ts` | Dedicated worker: pg-boss consumer + recovery sweep + graceful shutdown |
| `src/lib/hooks/useGenerationStream.ts` | EventSource hook, terminal detection, reconnect bookkeeping |
| `src/components/generation/GenerationContext.tsx` | Context + types |
| `src/components/generation/GenerationProvider.tsx` | Global restore/refresh, per-job SSE subscriptions, toasts, `router.refresh()` |
| `src/components/generation/GenerationDock.tsx` | Global indicator, activity panel, notification centre, minimise/expand |
| `src/components/generation/GenerationStatusBadge.tsx` | Chapter/status chips |
| `src/app/api/generations/route.ts` | `POST` create, `GET` history/active jobs |
| `src/app/api/generations/[jobId]/route.ts` | Owner-scoped details |
| `src/app/api/generations/[jobId]/events/route.ts` | SSE: snapshot, replay, progress, heartbeat, connection cap |
| `src/app/api/generations/[jobId]/cancel/route.ts` | Cooperative cancel |
| `src/app/api/generations/[jobId]/retry/route.ts` | Manual retry |
| `src/app/api/notifications/route.ts` | Notification list + unread count |
| `src/app/api/notifications/[notificationId]/route.ts` | Mark one read |
| `src/app/api/notifications/read-all/route.ts` | Mark all read |
| `tests/generation/background-generation.test.ts` | 16 lifecycle/reliability/persistence/worker/pg-boss tests |
| `tests/generation/sse.test.ts` | 16 API/SSE/security/notification tests |
| `tests/generation/generation-ui.test.tsx` | 4 client SSE hook/badge tests |
| `docs/background-generation.md` | Architecture/runbook |
| `docs/background-generation-implementation-report.md` | This report |

### Modified

- `src/lib/queue/index.ts` — pg-boss dispatch, stages, events, cancellation,
  heartbeat, stale recovery, retry conflict guard, completion re-read.
- `src/services/chapters/service.ts` — limits/idempotency, stage reporting,
  abort signal, in-transaction cancel check, crash-resume, `generationStatus`.
- `src/lib/db/migrations.ts` — migration `0013_background_generation`.
- `src/lib/db/postgres.ts` — camelCase mapping for every new column
  (`generationStatus`, `currentStage`, `progressPercentage`, `seq`, `isRead`,
  `dedupeKey`, `generationJobId`, heartbeat/queue/stage timestamps, …).
- `src/lib/workflow/navigation.ts` — `generationStatus` on navigation rows.
- `src/components/editor/WritingWorkspace.tsx` — context-driven status, stage
  bar, cancel, retry, FAILED/CANCELLED states, editor content sync after
  completion (no manual reload).
- `src/components/outline/OutlineEditor.tsx` — chapter-library status and
  actions (view status/return/cancel/retry/regenerate/generate).
- `src/components/layout/Sidebar.tsx` — notification bell with unread badge and
  popover, plus a live "Generating chapter" entry.
- `src/components/providers/index.tsx` — `GenerationProvider` at the root.
- `src/app/api/health/route.ts` — queue transport/pg-boss/active-job reporting.
- `src/app/settings/page.tsx` — honest queue/database rows.
- `src/lib/security/rate-limit.ts` — `generationControl` rule.
- `src/lib/config/env.ts`, `next.config.mjs`, `tsconfig.worker.json`,
  `src/worker/index.ts`, `vitest.config.ts`, tests listed below.
- `README.md`, `DEPLOYMENT.md`, `.env.example`,
  `docs/production-readiness-audit.md` (historical note).
- Deleted `src/lib/queue/bullmq.ts`; removed `bullmq` and `ioredis`.

## 3. Dependencies

| Change | Package |
| --- | --- |
| Added | `pg-boss@^12.38.0` |
| Removed | `bullmq`, `ioredis` |
| Moved to production deps | `tsx@^4.23.15` (the worker runs TypeScript at runtime) |

## 4. Database changes (migration `0013_background_generation`)

- `chapters.generationStatus TEXT NOT NULL DEFAULT 'NOT_STARTED'`, backfilled
  to `COMPLETED` for `generated`/`edited`/`approved` rows. Content status is
  unchanged and remains independent.
- `generation_jobs`: `currentStage`, `progressPercentage` (nullable),
  `stageUpdatedAt`, `cancelRequestedAt`, `priority`, `queueJobId`,
  `lastHeartbeatAt`, plus indexes on `(chapterId,status)` and
  `(userId,taskType,status)`.
- `generation_events(id, seq, jobId, userId, novelId, chapterId, type, status,
  stage, payload, createdAt)` with unique `(jobId, seq)` where `seq > 0` and
  lookup indexes.
- `notifications(id, userId, kind, title, message, novelId, chapterId,
  generationJobId, isRead, dedupeKey, createdAt)` with unique `dedupeKey` and a
  user/unread index.
- Existing partial unique index `ux_jobs_active_idempotency` continues to
  prevent two active jobs for the same chapter.

Migrations run automatically on first database use and via `npm run db:migrate`.

## 5. API

| Method | Endpoint | Notes |
| --- | --- | --- |
| POST | `/api/generations` | Auth, ownership, writing gate, limits, duplicate collapse → `202 { jobId, status, eventsUrl, … }` |
| GET | `/api/generations` | Own history + `activeGenerations`, counts, limits |
| GET | `/api/generations/[jobId]` | Owner-only |
| GET | `/api/generations/[jobId]/events` | SSE, `retry: 3000`, snapshot, replay, heartbeat, terminal close |
| POST | `/api/generations/[jobId]/cancel` | `200`, then `409` when finished |
| POST | `/api/generations/[jobId]/retry` | `200` only for failed/cancelled; `409` if a newer job is active |
| GET | `/api/notifications` | Own notifications + unread count |
| PATCH | `/api/notifications/[id]` | Owner-only mark read |
| POST | `/api/notifications/read-all` | Mark all read |

All endpoints return `401` without a session and `404` for another user's
resources. Validation is Zod-based; errors never contain credentials.

## 6. Worker

```bash
# one-time / on deploy
npm run db:migrate

# process A — Next.js
npm run build && npm run start

# process B — dedicated background worker (persistent host)
npm run worker
```

`npm run worker:dev` watches sources locally. The worker:

1. opens the database and applies migrations;
2. consumes `novelforge.chapter-generation` with pg-boss (local concurrency
   `WORKER_CONCURRENCY`, default 2);
3. runs a database recovery sweep (stale jobs + other task types + missed
   pg-boss messages) every `WORKER_POLL_MS` (3s);
4. falls back to the sweep if pg-boss cannot start;
5. handles `SIGTERM`/`SIGINT`: stops consumers, waits up to
   `WORKER_SHUTDOWN_MS` (25s) for in-flight work, closes the pool.

Environment: `DATABASE_URL` (PostgreSQL, shared), `PG_BOSS_*`,
`WORKER_CONCURRENCY`, `WORKER_POLL_MS`, `WORKER_SHUTDOWN_MS`,
`QUEUE_STALE_JOB_MS`, `GENERATION_*`, `SSE_*` — all documented in
`.env.example`.

## 7. UI behaviour

- Global floating indicator mounted at the root; survives navigation and
  restores active jobs from the server after refresh.
- Multiple concurrent jobs, per-job stage text, indeterminate bar (never a
  fake percentage), cancel, retry, "View chapter".
- Activity tab shows active and recent jobs; notification tab shows durable
  notifications with unread badge, mark-one/mark-all.
- Sidebar bell + unread badge + notification popover; live generation entry.
- Chapter library statuses/actions: COMPLETED (open/edit/regenerate),
  IN PROGRESS (view status/return/cancel), FAILED (error/retry), NOT STARTED
  (generate).
- On completion the provider calls `router.refresh()`; the editor mirrors new
  chapter content into the mounted Tiptap instance without reloading, unless
  the author has unsaved typing.
- Unmounting anything only closes an SSE connection; no component can cancel a
  job implicitly.

## 8. Verification performed

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | **0 errors** |
| `npx next lint` | **No ESLint warnings or errors** |
| `npm run build` | **Compiled successfully**, 29/29 static pages, new API routes present |
| `npx vitest run` | **421 passed**, 16 failed (pre-existing baseline — see §10), 39 files |
| New suites | `background-generation` 16/16, `sse` 16/16, `generation-ui` 4/4, `queue` 13/13 |
| `npm run worker` (SQLite/database transport) | migrations applied, `[worker] ready`; SIGTERM → graceful `[worker] stopped` |
| Production server (`npm start`, SQLite) | `/`, `/login`, `/pricing` = 200; `/api/generations` and `/api/notifications` = 401 |
| pg-boss ESM load | `import('pg-boss')` works under Node 22 (native-import workaround for webpack CJS) |
| Postgres mapping | camelCase test covers all `0013` columns |

## 9. Security

- Session required on every generation/notification endpoint, including SSE.
- Ownership enforced by `requireNovel` / `requireJob`; chapter ids must belong
  to the owned novel.
- Rate limits: `RATE_LIMIT_AI_PER_HOUR` for creation/retry,
  `RATE_LIMIT_GENERATION_CONTROL_PER_HOUR` for cancel, AI budget/token guards
  retained.
- SSE per-user connection cap (`SSE_MAX_CONNECTIONS_PER_USER`, default 6,
  per process).
- Chapter overwrites require the existing explicit confirmation path.
- Error messages are sanitised; credentials never appear in responses or logs.

## 10. Pre-existing test failures (not introduced here)

Before any change, `main` at `f2eaead` had **17 failed / 382 passed** of 400
tests. The run after this work is **16 failed / 421 passed** of 437 (one
pre-existing hosted-inference test now runs instead of being blocked by forced
demo mode). The remaining 16 failures are the same provider/demo guard drift:

- `tests/ai/api-security.test.ts` — model catalogue count (70) assertion.
- `tests/ai/novel-workflow.test.ts` — hosted-model selection/eligibility
  expectations versus the current Agnes-primary registry.
- `tests/jobs/job-lifecycle-and-ai-controls.test.ts` — demo-mode overwrite
  scenario.
- `tests/workflow/chapters.test.ts` and
  `tests/workflow/end-to-end-authoring.test.ts` — tests that expect demo
  chapters while the product now refuses demo generation by design
  (`AI_DEMO_MODE=true` → 503, “No demo chapter was created”).

They were not caused by background generation, and fixing them would require
changing product policy (re-enabling fabricated demo chapters) or rewriting
provider-fixture expectations, which is outside this task.

## 11. Limitations and notes

- **No PostgreSQL server was available in the build environment.** pg-boss
  itself was not exercised end-to-end against a live database. What was
  verified: pg-boss loads under Node 22, its producer/consumer paths are covered
  by an injected deterministic fake (`FakeBoss`: `singletonKey`, redelivery
  no-op, database fallback), and every durable path (jobs, events, notifications,
  recovery, restart) is tested on the real SQLite implementation with the
  simulated-PostgreSQL translation/sync backend.
- **No live AI credentials** were available, so real provider throughput was
  not measured; existing provider integrations and demo guards were left as-is.
- Serverless hosts cannot run the worker and may cut long SSE responses; the job
  continues and reconnects replay events. Run the worker and, preferably, the
  app on a persistent Node.js host.
- Rate limiting and the SSE connection cap are per process (existing project
  behaviour); use a gateway/shared limiter for a large multi-instance fleet.
- pg-boss creates its own `pgboss` schema; the database role needs `CREATE` on
  it (or the schema can be pre-created).
