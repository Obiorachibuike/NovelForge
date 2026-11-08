# Universal AI generation — repair report

**Date:** 2026-11-05
**Branch:** `arena/9d8a7b95-novelforge`
**Base:** `466a7b8` (`main`)

This report covers the eleven areas named in the audit brief. Every claim below
was verified by executing the command or reading the code, not by assumption.
Numbers at the bottom (`§11`) are the executed results.

---

## 1. One universal generation engine

There is exactly **one** generation engine and **one** handler registry in the
tree: `src/lib/ai/generation/`.

| Concern | Location |
| --- | --- |
| Vocabulary (types, providers, Zod schema) | `generation-types.ts` |
| Custom-handler registry | `generation-registry.ts` |
| Durable rows, chunks, events, finalisation | `generation-persistence.ts` |
| Execution (text + image), provider chain | `generation-service.ts` |
| Cross-field validation helpers | `generation-validation.ts` |

A web-application "second engine" was removed rather than duplicated: the
universal dispatch had been copied into `api/generations/route.ts` and into
`services/{chapters,outlines,preparation,images}/service.ts`, where it was dead
and broken (it could never be reached). Those copies are gone; the only entry
point is `POST /api/generations/universal` (plus the `/api/generations/create`
alias) → `insertGenerationJobRow` → `runJob`'s `isUniversalEngineJob` branch.
`migration-registry.ts` and `generation-recovery.ts`, which existed only to
serve the duplicate path, were deleted.

**Engine discrimination** is a persisted marker, never a capability probe:
`isUniversalEngineJob(row)` reads `payload.engine === 'universal'` from the job
row. `hasHandler()` is used in exactly one place — as the `customHandler`
capability flag inside the SSE snapshot — and an unknown/missing marker fails
loudly instead of being guessed.

## 2. Generation vocabulary: one definition, no duplicates

`GENERATION_TYPE_VALUES` (30 entries) is the single source of truth; the Zod
enum is derived from it, so the TypeScript union and the runtime validator can
never drift. The 30 types cover every artefact the brief lists: novel title /
description / summary, story idea, story and chapter outline, premise, outline,
blurb, author bio, marketing copy, chapter, **page**, **scene**, memory,
character, backstory, relationships, worldbuilding, location, culture, history,
rewrite, expand, summarize, shorten, proofread, humanize, image, plus a
deliberate `custom` extension point.

Extension is explicit, not string-widening: `generationType: 'custom'` requires
a slug `customType`, `CUSTOM_GENERATION_PREFIX` marks caller-supplied types, and
`parseGenerationType()` maps `custom:<slug>` to `'custom'` while returning `null`
— never a guess — for anything unsupported. A test asserts that an arbitrary
string is rejected and that TypeScript/Zod stay in sync (count and membership
are compared at runtime).

## 3. Real job IDs, end to end

`UniversalGenerationService.createJob()` inserts the row first and then runs the
job **by that id**. `handleTextGeneration(jobId, …)` and
`handleImageGeneration(jobId, …)` take the real `jobId` as their first
parameter; every persistence call (`openChunkSink(jobId)`,
`completeGenerationJob(jobId, …)`, `failGenerationJob(jobId, …)`) uses it.
`projectId`/`novelId` are never used as a job id — a regression test asserts the
image job finalises *itself* and that the novel row is untouched. Request/job
mismatches (`generationRequestFromJobRow` vs the submitted request) are rejected
before any provider call.

## 4. Single, idempotent finalisation

`completeGenerationJob` and `failGenerationJob` are the only writers of a
terminal status. Both are compare-and-set on `status='processing'`:

```sql
... WHERE id = ? AND status = 'processing'
```

so a duplicate delivery, a late worker or a cancel-then-complete race cannot
overwrite a `completed` / `failed` / `cancelled` row (a second attempt returns
`false` and records nothing). Cancellation is terminal and is never revived:
the requeue path refuses cancelled rows. Tests assert one `generation_failed`
event on permanent failure, `retryable = 0`, and that a cancelled job is never
resurrected.

## 5. Durable chunks and events with monotonic sequence numbers

`openChunkSink(jobId)` persists every streamed delta as a `generation_events`
row with a **monotonic per-job `sequence`**, resuming from the highest persisted
sequence, so numbering survives a worker restart. `progress` events,
`stage` transitions and terminal events go through the same log. Consumers
dedupe on `sequence` because a reconnecting SSE client legitimately receives
replayed deltas. Tests cover chunk order/concatenation without duplication,
`stream: false` emitting no chunks, and chunk durability across a simulated
worker restart.

## 6. Provider routing preserved

Priority is unchanged: **Agnes AI (primary) → Hugging Face → OpenAI**.
`resolveProviderChain(request, env)` honours an explicitly requested provider
and only appends alternatives when `metadata.allowFallback !== false`; a pinned
provider never switches implicitly. No result is fabricated: if the chain is
empty or every provider fails, the job fails with the real reason and a bounded
retry policy.

Demo output remains a **labelled** mode, never a silent one:

- `AI_DEMO_MODE=true` **and** a provider key configured → chapter generation
  refuses with `text_provider_unavailable` (no demo prose in a deployment that
  could write real prose).
- `AI_DEMO_MODE=true` with no key → chapters are produced as demo text,
  persisted with `generationSource='demo'` and returned with `demo: true`.
- No key and no demo opt-in → 503 with deployment instructions.
- A provider failure never becomes demo text (`allowFallbackOnError` is false
  for chapters).

## 7. Real streaming and cancellation

Streaming is real: deltas come from the provider's SSE through
`readChatStream`, which now also recovers a **buffered JSON completion** from a
gateway that ignores `stream: true` (previously that was misreported as
`empty_output`, and the model was then penalised out of the fallback chain —
the root cause of the chapter failures).

`AbortSignal` is threaded from the job's `AbortController` through
`generateTextDetailed` → provider clients. The queue aborts the in-flight
request on cancellation, and `runChapterGeneration` now fails fast if
`isCancelled()` is already true, so a cancelled job never spends tokens or
touches the chapter. Non-streaming providers are never presented as streaming:
chunks exist only where the provider really streamed.

## 8. SSE endpoint

`GET /api/generations/[jobId]/events`:

- authenticated (`requireUser`) and owner-scoped (`requireJob`; a foreign job is
  a 404, not a 403 with data);
- replays from `Last-Event-ID` (`decodeEventCursor`) out of the persisted event
  log, then tails it;
- sends heartbeats (`SSE_HEARTBEAT_MS`, default 15 s), polls
  (`SSE_POLL_MS`, default 1 s);
- caps concurrent streams per user (`SSE_MAX_CONNECTIONS_PER_USER`, default 6);
- emits an initial `snapshot` (`generationSnapshot`) carrying `engine` and
  `customHandler`, then closes after a terminal event.

One implementation serves both engines: the stream is engine-agnostic because
both write the same `generation_events` rows.

## 9. Dedicated worker (never a Vercel function)

`npm run worker` → `src/worker/index.ts` is a long-lived Node.js process: pg-boss
consumer, stale-job sweep, heartbeats and graceful `SIGTERM`/`SIGINT` shutdown.
It is **not** started from a Route Handler and `vercel.json` only builds the
Next.js app. `DEPLOYMENT.md` documents that the worker must run on a container /
VM host (Fly, Railway, Render, k8s, EC2) because serverless functions freeze
after the response. PostgreSQL + pg-boss remain the only queue; no Django,
Python, Celery, Redis or RabbitMQ was introduced.

## 10. Progressive, resumable frontend

`src/lib/hooks/useGenerationStream.ts` opens an `EventSource` per job, folds
`generation_snapshot|queued|started|progress|content|completed|failed|cancelled`
into one view model, accumulates deltas de-duplicated by `sequence` (trusting a
longer replayed snapshot), fires `onTerminal` exactly once and closes only the
local channel on unmount — it never cancels the job. `GenerationProvider`
polls the active jobs **and** `/api/generations/universal?limit=20`, so universal
jobs survive a reload. `GenerationDock` titles non-chapter jobs from
`taskTypeLabel()` (every generation type has a label), shows a three-line
partial-text preview, and switches its action to "View chapter" / "Open novel".

## 11. Security, database, build and verification

- **Security:** ownership checks stay in place on every route (universal create
  validates the novel belongs to the caller; the SSE and cancel routes 404 on a
  foreign job). The HTTP contract no longer carries `userId` at all —
  `GenerationJobRequestSchema` omits it and the session identity is injected — so
  a spoofed `userId` in the body is discarded rather than trusted. Prompts and
  context payloads are size-capped (`MAX_PROMPT_CHARS`, `MAX_CONTEXT_CHARS`),
  rate limits are unchanged, and error messages are sanitised (keys, bearer
  tokens and DSNs redacted) before they reach a row, a response or a log.
- **Database:** unchanged engine (PostgreSQL in production, the same
  ORM/database facade, the same migrations). No SQLite was added for
  production; tests continue to use the existing SQLite test harness.
- **Vercel/Node:** `engines.node` stays `22.x` (unchanged) because the
  dependency set builds and tests cleanly on Node 22.22.3; no blind bump to 24.x.
- **`npm audit`:** two safe in-range updates applied (`markdown-it` 14.3.2 →
  14.3.3, `postcss-selector-parser` 6.1.4 → 6.1.5), 51 → 49 advisories. The
  remainder need major upgrades (Next 16, zod 4, vitest 5, openai 7) and were
  deliberately **not** forced: `npm audit fix --force` was never run.
- **Unrelated pre-existing issue fixed while verifying:** `recordGenerationUsage`
  attempted an INSERT without a `userId` on job-less paths, logging a NOT NULL
  constraint error. Usage without an owner is now skipped explicitly instead of
  failing an insert.

### Reconciliation with `main`

`main` moved while this branch was open (`85b52f0`, PR #26) and touched the same
ten files. The conflict was resolved by keeping this branch's architecture — the
persisted-marker engine, no `hasHandler()` dispatch — and porting the fixes from
`main` that were still missing here:

- `validateGenerationInput(input, userId)` in `generation-validation.ts`, now
  used by the universal route so the authenticated identity always wins;
- the `buildDemoOutline` word-budget fix (`avg` per chapter, `estimatedPages`
  derived from it);
- its three new tests (`request-validation`, `universal-validation`,
  `outline-target`) and `docs/audit-2026-11-01.md`, all kept and passing.

### Executed results

| Check | Baseline (`466a7b8`) | Now |
| --- | --- | --- |
| `npx tsc --noEmit` | 62 errors | **0 errors** |
| `npx vitest run` | 104 failed / 333 passed | **471 passed / 471** (43 files) |
| `npm run lint` | — | clean (no warnings) |
| `npm run build` | failing | **succeeds** (only an offline font-download warning) |
| `npm audit` | 51 advisories | 49 (2 fixed safely) |

New coverage: `tests/generation/universal-engine.test.ts` (29 cases) exercises
the vocabulary, registry, provider chain, durable job creation and idempotency,
streamed chunk order/durability, image finalisation, cancellation, permanent vs
transient failure, SSE replay/`Last-Event-ID`/ownership, the universal HTTP API
and legacy-engine isolation.

### Known limitations (reported, not hidden)

- 49 advisories remain until the major upgrades above are scheduled; the
  `next` advisory is the most serious and requires Next 16.
- The SSE per-user connection cap is per process, not global (documented in the
  route as a resource guard, not a security boundary).
- `recordGenerationUsage` cannot attribute usage that has no owning account, so
  such calls are not billed in `ai_usage` by design.
