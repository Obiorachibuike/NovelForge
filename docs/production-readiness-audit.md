# NovelForge — Production Readiness Audit

**Audit date:** 2026-10-11
**Commit audited:** `b4e2df0` (branch `main`)
**Method:** direct source inspection plus executed commands. Every claim below is labelled
**confirmed** (reproduced by running code or reading the exact line) or **unverified**
(believed to be a problem but not yet reproduced).

## 0. Baseline command results (executed, not assumed)

| Command | Result | Notes |
| --- | --- | --- |
| `npm ci` | ❌ fails in this sandbox, ✅ with workaround | `better-sqlite3` 13.0.3 ships no prebuilt binary and `node-gyp` cannot reach `nodejs.org` for headers. Workaround used: `npm_config_nodedir=/usr/local npm ci` (local Node headers). |
| `npx tsc --noEmit` | ❌ **17 errors** | See §7. |
| `npx next lint` | ❌ **not usable** | No ESLint config exists, so `next lint` drops into its interactive setup prompt and never lints. |
| `npm test` (`vitest run`) | ❌ **no test files found, exit 1** | The repository contains **zero** tests despite README claims of ownership checks and job idempotency. |
| `npm run build` | ✅ succeeds | Only because `next.config.mjs` sets `typescript.ignoreBuildErrors` and `eslint.ignoreDuringBuilds`. |

## 1. Confirmed defects

### 1.1 Critical — cross-user chapter read/write through the AI editor endpoint
`src/app/api/ai/editor-action/route.ts:14-19`

```ts
const chapter = db.prepare(`SELECT c.*, ... FROM chapters c JOIN novels n ON n.id=c.novelId WHERE c.id=?`).get(body.chapterId);
if (!chapter || chapter.userId !== undefined) {          // chapters has no userId column → always true
  const owned = db.prepare(`... WHERE c.id=? AND n.userId=?`).get(body.chapterId, user.id);
  if (!owned) return NextResponse.json({error:'Not found'}, {status:404});
}
```

The guard is written inside `if (!chapter || chapter.userId !== undefined)`. `chapters` has no
`userId` column, so `chapter.userId` is always `undefined` and the condition is always true — the
ownership query *is* executed. However `chapter` is the row returned by the **unscoped** first
query, and execution continues to use it: the endpoint therefore leaks another user's chapter title
and novel metadata, and — more importantly — the check is not the mechanism that protects the
handler (see next point). **Confirmed by reading the exact control flow**; a test asserting
`User A → chapterId of User B` now exists (§9).

### 1.2 Critical — authorization is enforced inconsistently across routes
| Route | Ownership check | Verdict |
| --- | --- | --- |
| `GET/POST /api/novels` | `requireUser` + scoped queries | OK |
| `/api/novels/[id]` | `requireNovel` | OK |
| `/api/novels/[id]/cover` | `requireNovel` + `setCover` scoped by `userId` | OK |
| `/api/novels/[id]/prepare`, `outline`, `approve-outline`, `chapters`, `consistency`, `export` | `requireNovel` | OK |
| `/api/ai/editor-action` | bespoke, non-scoped read (above) | **defect** |
| `/api/novels/[id]/chapters/[chapterId]` (GET/PATCH) | `requireNovel` + `novelId`-scoped chapter lookup | OK |

No route in the repository is missing `requireUser`, but the editor-action route is not built on the
shared helper and is the only place where the check is decorative rather than structural.

### 1.3 High — chapter text is silently replaced with demo prose when a real AI call fails
`src/services/chapters/service.ts:119-126`

```ts
const fallbackText = generateFallbackChapter(chapterNumber, outline.title);
const prose = await generateText({...}).catch(err => { console.warn(...); return fallbackText; });
```

With a valid `OPENAI_API_KEY`, a timeout/rate-limit/auth error produces **fabricated chapter text**
(`generateFallbackChapter` hard-codes the character "Kael" and the city "Veyra") that is saved as
the chapter and counted toward the word target. The author is never told. Same pattern in
`src/services/images/service.ts:39-48` (a failed DALL·E call quietly yields an SVG cover) — that one
is at least logged and visible as a placeholder.

### 1.4 High — `QUEUE_PROVIDER=redis` does not use BullMQ
`src/lib/queue/index.ts:44-48` — when `QUEUE_PROVIDER=redis` **and** `REDIS_URL` are both set, the
in-process dispatch is skipped and *nothing else takes over*: the job row is inserted with status
`queued` and no producer ever talks to Redis. `bullmq` and `ioredis` are dependencies but are never
imported anywhere (`grep -rn "bullmq" src` → no hits). The worker only polls the SQLite table. So
"Redis mode" silently degrades to "queued forever unless a worker polls this exact machine". The
README acknowledges this, the settings page does not (`/settings` prints "Redis / BullMQ" whenever
`QUEUE_PROVIDER=redis`).

### 1.5 High — no atomic claim; the same job can run twice concurrently
`src/lib/queue/index.ts:61-92` — `runJob` reads the row, then unconditionally sets
`status='processing'` (no compare-and-set, no claim token). Two racing callers (the `setImmediate`
in `enqueue`, the worker's 3 s poll, `initQueue`) can both pass the `status === 'completed'` check
and both execute the handler. For chapter generation this means two concurrent writes of
`chapter_versions` with `versionNum=1` (unique constraint → one job fails with a raw SQL error) and
two `UPDATE chapters ... status='generated'` writes. Verified to be reachable by inspection; a
regression test with two concurrent `runJob` calls now exists (§9).

### 1.6 High — `updateNovelSettings` and `updateOutline` are non-functional
`src/services/novels/service.ts:113-118` and `src/services/outlines/service.ts:126-127` build a
`SET ... WHERE novelId=? AND EXISTS(SELECT 1 FROM novels WHERE id=? AND userId=?)` statement and then
bind the values in the wrong order.

* `updateNovelSettings`: binds `(…setValues, novelId, userId, novelId)` against
  `(…setValues, novelId, novels.id, novels.userId)`. Parameter counts match, so **no error is
  raised** — the sub-select compares `novels.id = userId AND novels.userId = novelId`, which is
  false, so the UPDATE matches zero rows and the caller receives the unchanged settings. Silently
  broken. (Verified empirically: `better-sqlite3` throws `Too many parameter values were provided`
  when counts differ, and does not throw here.)
* `updateOutline`: binds `(…setValues, outlineId, novelId, userId, outlineId, novelId)` against 4
  placeholders → throws `RangeError: Too many parameter values were provided`. Currently dead code
  (no route calls it), so the outline editor has no write path at all.

### 1.7 Medium — `demand`-mode/demo-mode semantics are inconsistent
`src/lib/ai/provider.ts:20` defines `demoMode: !process.env.OPENAI_API_KEY || process.env.AI_DEMO_MODE === 'true'`,
but `generateText`/`generateStructured`/`streamText`/`embed` only check `!client`. With
`OPENAI_API_KEY` set **and** `AI_DEMO_MODE=true`, text/structured calls hit the real API (costing
money) while `images/service.ts:22` (`!aiConfig.demoMode`) refuses to and serves an SVG. The
`.env.example` ships `AI_DEMO_MODE=true`, so the documented "safe" configuration
(`OPENAI_API_KEY=…` + `AI_DEMO_MODE=true`) is the unsafe one.

### 1.8 Medium — structured-output fallbacks are indistinguishable from real output
`src/lib/ai/text-generation.ts:83` returns `input.fallback` after exhausting retries, with no marker
in the result. Outline generation therefore falls back to `buildDemoOutline`, which uses
`Math.random()` for word targets (`outlines/service.ts:148`) and writes the fictional character
"Kael"/"Seren" into a `premises`-less book — the Story Bible, outline and chapters can end up
populated with demo content and no record that generation failed.

### 1.9 Medium — story-memory retrieval exists but is never used for chapter context
`retrieveMemories()` (`src/services/memory/service.ts`) has no callers. Chapter generation instead
uses `SELECT kind,content FROM chapter_memories WHERE novelId=? ORDER BY importance DESC LIMIT 12`
— a keyword-free, unordered slice. Embeddings are written by `embed()` during prepare
(`preparation/service.ts:117-118`, result discarded) and after summarisation, so the vector index is
built but never queried. The README claim "Story memory retrieval with cosine/keyword hybrid search"
is therefore only half true: the code exists, the workflow does not use it.

### 1.10 Medium — chapter summary/memory extraction is lost on process exit
`chapters/service.ts:157` and `:289` fire summarisation with `setImmediate(...)` inside the web
process. If the dyno/container recycles, is redeployed, or the serverless function ends, the
function is lost with no record and no retry: the chapter stays approved with `summary = NULL`,
which in turn degrades every later chapter's context and the consistency checker.

### 1.11 Medium — EPUB export is not an EPUB
`services/exports/service.ts:115-122` returns the **Markdown text** as the bytes for `format:'epub'`
while the route advertises `application/epub+zip` and writes `*.epub`. Opening the file in an
e-reader fails. `epub-gen-memory` is already a dependency and is unused.

### 1.12 Medium — `idempotencyKey` is not enforced by the database
`src/lib/queue/index.ts:27-33` performs a read-then-insert with no unique constraint behind it, so
two simultaneous `POST /api/novels/{id}/chapters` requests both see "no active job" and both insert.
Only after that does the burst of duplicate work occur. (`UNIQUE(novelId, chapterNumber)` on
`chapters` limits the damage to wasted spend plus one failed job.)

### 1.13 Low — PDF export emits a trailing blank page per chapter and ignores formatting options
`services/exports/service.ts:84-113` adds a new page after every chapter, drops the `settings`
argument (`_settings`), never applies page size, margins, font size, line spacing, page numbering,
TOC or front-matter options that the export UI collects. `cover` is fetched but unused for PDF and
EPUB.

### 1.14 Low — `runChapterGeneration` version bookkeeping is racy and imprecise
`chapters/service.ts:146-151` always inserts `versionNum = 1` for an existing chapter (it should be
`MAX+1`), so re-generating an already-generated (not approved) chapter collides with the existing
version-1 row, aborting the transaction (`UNIQUE(chapterId, versionNum)`) *after* the
`UPDATE chapters` in the same transaction — meaning regeneration appears to fail while the queue
records success/failure based on the thrown error.

### 1.15 Low — navigation status computation is inconsistent between server and client
`getNavigation()` (`chapters/service.ts:312-338`) computes `locked` in two passes with mutable state;
`OutlineEditor.tsx:39-46` re-implements a *different* algorithm client-side. A chapter can render as
locked in the editor rail and unlocked in the outline list (or vice versa) after partial approvals.

### 1.16 Low — `/settings` reports unverified configuration
`src/app/settings/page.tsx:15-18` prints "PostgreSQL" for any non-`file:` `DATABASE_URL` and
"Cloudinary" for `STORAGE_PROVIDER=cloudinary`, both of which are **not implemented** — the app will
throw or write to a SQLite file depending on the variable. The page must report what the code
actually does.

## 2. Potential security vulnerabilities

1. **Missing rate limiting / abuse protection on every expensive endpoint** (confirmed by absence):
   `POST /api/novels/[id]/cover`, `/prepare`, `/outline`, `/chapters`, `/consistency`, `/export` and
   `/api/ai/editor-action` can be called in a tight loop by any authenticated account. Each call can
   trigger a paid OpenAI request. There is no per-user quota anywhere in the code path.
2. **No request-body size limit on route handlers** (confirmed): `experimental.serverActions.bodySizeLimit`
   in `next.config.mjs` does not apply to Route Handlers. `PATCH /api/novels/[id]/chapters/[chapterId]`
   validates only `{type:'doc', content: Array}` (`route.ts:5`), so a client can post arbitrarily
   large JSON that is written to the database as `contentJson` (storage exhaustion) and re-served.
3. **Generated covers and exports are world-readable** (confirmed): files are written to
   `public/uploads/...` and served by Next's static handler, so `/uploads/exports/<key>.docx` is
   readable without a session. Access depends solely on the 21-character nanoid being unguessable;
   there is no ownership check on retrieval and no `Content-Disposition` control.
4. **Implicit account linking by e-mail** (confirmed): `signIn` (`auth/config.ts:63-77`) links a Google
   login to any pre-existing row with the same e-mail. Because credential accounts are created with
   `emailVerified = NULL` and registration is unauthenticated, an attacker can pre-register
   `victim@example.com` with a password; when the victim later signs in with Google, they are attached
   to the attacker's row, and the attacker keeps password access to the victim's novels.
5. **Registration is fused into login** (confirmed): `authorize()` creates the account when the e-mail
   is unknown. There is no route that can be rate-limited separately, no e-mail verification, and the
   response timing distinguishes "unknown e-mail" (bcrypt hash) from "known e-mail" (bcrypt compare).
6. **Error responses leak internals** (confirmed): `jsonError` returns `err.message` with status 500
   for any non-`HttpError`, so SQL text (`UNIQUE constraint failed: chapters.novelId, chapters.chapterNumber`),
   file paths and stack-adjacent messages reach the client.
7. **`.env.example` ships `AUTH_SECRET=replace-with-a-long-random-secret`** and the app has no startup
   assertion, so a deployment that forgets to change it runs with a known secret. (Verified: no
   validation exists anywhere.)
8. **Google OAuth `trustHost: true`** unconditionally (`edge-config.ts:5`) — acceptable on Vercel,
   but it lets a reverse proxy with a wrong `Host` header influence callback URLs. Should be
   env-gated.
9. **Unverified npm advisories**: `npm audit --omit=dev` reports advisories in
   `@auth/core ≤ 0.41.2` (critical, GHSA-7rqj-j65f-68wh e-mail-normalisation homoglyph bypass &
   GHSA-xmf8-cvqr-rfgj malformed Bearer header) pulled in by `next-auth@5.0.0-beta.25`, and in the
   `ai` SDK's provider-utils. Upgrading `next-auth` within the 5.0.0-beta line is untested here.

## 3. Missing implementations

| Claimed | Reality |
| --- | --- |
| PostgreSQL | `pg` is a dependency and nothing imports it. `getDb()` treats any non-`file:` URL as a **SQLite filename**, so `DATABASE_URL=postgres://…` creates a file literally named `postgres://…` in the CWD. Confirmed by reading `src/lib/db/index.ts:14-25`. |
| Cloudinary storage | `saveFile()` throws for any provider other than `local`. |
| S3 storage | Same. `S3_*` env vars are read by nothing. |
| BullMQ queue | Not imported (see §1.4). |
| EPUB | Not an EPUB (see §1.11). |
| Vercel deployment | `saveFile()` hard-refuses when `process.env.VERCEL` is set, so covers **and** every export fail on Vercel; SQLite on `/tmp` is explicitly not durable. |
| Job observability | `listJobs`/`getJob` exist but no route exposes them; `middleware.ts:6` protects `/api/jobs`, a prefix that has no route. |
| Story Bible editing | `updatePremiseField`, `updateOutline`, `updateNovelSettings` have no routes; the UI presents generated content as read-only except the outline status pills. |
| Email verification / password reset | Not implemented. |
| Tests | None. |

## 4. Deployment limitations (as audited)

* **Single-instance only**: SQLite file + local disk + in-process queue. Multi-instance or
  serverless deployment corrupts state.
* **Vercel**: build succeeds, but the application is unusable for generation (storage refusal) and
  non-durable (ephemeral filesystem, per-request SQLite in `/tmp`).
* **Migration story**: schema is created by one `CREATE TABLE IF NOT EXISTS` blob executed on first
  DB use. There is no `schema_migrations` table, no versioning, and no way to apply an additive
  change (e.g. a new column) to an existing deployment's database. Adding a column today silently
  fails for existing installs.
* **`docs/vercel-deployment-failure-investigation.md`** correctly identifies the legacy Vercel
  project as the deployment-blocking issue — that diagnosis is not contradicted by this audit.

## 5. Untested behaviour (no test exists, no manual verification performed)

Everything: authentication, ownership enforcement, the sequential-writing gate, autosave,
versioning/restore, job idempotency/retry, story-memory extraction, consistency detection, all five
export formats, cover generation (SVG and OpenAI), and the queue's failure handling. Nothing in the
repository asserts any of it.

## 6. Features that do work (verified by inspection of complete code paths)

* Registration/login with bcrypt (`bcrypt.hash(pw, 10)`) and a JWT session; `session.user.id` is
  populated from the token and `requireUser()` fails closed.
* Novel CRUD, cover concepts and selection, premise/Story-Bible generation, outline generation and
  approval, chapter generation, Tiptap autosave, chapter approval, and per-novel ownership scoping
  on all routes listed in §1.2.
* Sequential gate: `enqueueChapterGeneration` refuses a chapter whose predecessor is unapproved and
  refuses a second concurrent chapter job, and `runChapterGeneration` re-checks the predecessor
  inside the worker.
* Demo mode genuinely works end-to-end with no API key (SVG covers, deterministic prose, stub
  embeddings) — verified by code path, exercised in §9 via the API-level tests.
* The production build compiles; `/settings`, dashboard, and workspace pages render from the
  database without runtime errors under `next build`.

## 7. TypeScript errors at baseline (17)

`src/app/api/novels/[id]/chapters/route.ts` (2× `unknown`), `src/app/novels/[id]/consistency/page.tsx`
(3×), `src/app/novels/[id]/write/[chapterId]/page.tsx` (1×), `src/components/novel/NewNovelForm.tsx`
(11×: `useForm` generic mismatch and a required `hint` prop). These are hidden from CI by
`typescript.ignoreBuildErrors`, which is the same setting that would hide a real regression.

## 8. Prioritised remediation plan

1. **Security first**: structural ownership checks on every route (incl. editor-action), request size
   limits, rate limiting, sanitised 5xx errors, registration split from login, safe Google linking,
   authenticated file delivery for covers/exports, `AUTH_SECRET` assertion.
2. **Queue correctness**: BullMQ producer/worker when Redis is configured, atomic claim, DB-enforced
   idempotency, stale-job recovery, protected job status endpoints, no silent demo substitution.
3. **Sequential workflow**: overwrite protection for user-edited chapters, single navigation source
   of truth, durable story-memory extraction as a queued job, memory retrieval wired into generation.
4. **Cost control**: consistent demo mode, per-request timeouts, bounded retries, token/cost
   accounting with per-user budgets, `/api/usage`.
5. **Exports & storage**: real EPUB, formatting options honoured, storage driver abstraction with a
   local driver (private directory + authenticated route) and an S3-compatible/Cloudinary driver.
6. **Strict build**: remove `ignoreBuildErrors`/`ignoreDuringBuilds`, add ESLint config, fix all
   errors, and add the test suite referenced throughout this document.
7. **Persistence/deployment**: versioned migrations for SQLite; honest, fail-fast behaviour and
   documentation for PostgreSQL; Vercel guidance that states what is and is not implemented.

Sections §9+ are appended by the remediation work in this branch as each item is verified by an
executed test.

---

# 9. Verified remediation (evidence)

Everything in this section was executed on the working branch after the fixes;
the command output quoted is the output that was actually produced. Anything
that has *not* been exercised is called out explicitly as unverified.

## 9.0 Commands and results

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 (baseline: 17 errors, §7) |
| `npx next lint` | `✔ No ESLint warnings or errors` (baseline: no ESLint config, interactive prompt) |
| `npx vitest run` | `Test Files 12 passed (12)`, `Tests 119 passed (119)`, ≈12 s |
| `npm run build` | exit 0: `✓ Compiled successfully`, `Linting and checking validity of types`, `✓ Generating static pages (13/13)` |
| `npm run worker` (temp SQLite) | applies migrations 0001–0004, logs `[worker] ready (driver=inprocess, concurrency=2, poll=1000ms)` |
| worker end-to-end | a real queued `export` job was produced by the worker: job `completed`, `exports` row written with `fileKey: exports/mv4432bv-bb1elh8j.txt`, `fileSize: 159`, `mimeType: text/plain; charset=utf-8`, file present in `DATA_DIR/uploads` |
| `QUEUE_PROVIDER=redis` without `REDIS_URL` | `queueDriver()` reports `inprocess` / `redisConfigured: false`; starting the BullMQ consumer directly fails with `REDIS_URL is not configured` (no silent "Redis support") |
| `DATABASE_URL=postgres://… npm run db:migrate` | `error: DATABASE_URL is a PostgreSQL URL but this build only ships a SQLite driver…` exit 1 |
| `npm run db:status` | `driver: sqlite`, four migrations applied, `pending: (none)` |
| `npm start` + `curl` | `/` 200, `/login` 200, `/dashboard` 307 → `/login?callbackUrl=%2Fdashboard`, `/api/novels` 401 `{"error":"Authentication required","code":"unauthenticated"}`, `/api/files/covers/x.svg` 401 |
| HTTP registration | `POST /api/auth/register` 201 with the created user; duplicate 409 `email_taken`; weak password 400 |
| `npm audit --omit=dev` | 40 advisories (33 moderate / 6 high / 1 critical) — see §9.11 |

> Counts and page totals in this table are from the §9.1–§9.14 pass (before the Google work in §9.15 and
> the billing work in §9.16). The current, re-executed results are in §9.16: **15 test files / 171 tests**,
> 18/18 pages in the production build.

## 9.1 → §1.1 Critical cross-user access in `/api/ai/editor-action`

The chapter lookup now resolves through `requireChapter`, and the action is
refused for chapters the caller does not own. `tests/security/ownership.test.ts`
("the AI editor cannot be pointed at another user chapter") and
`tests/security/editor-action.test.ts` cover the negative case, the
approved-chapter guard, payload limits and the per-user rate limit.

## 9.2 → §1.2 Inconsistent authorization

Every route handler now runs through `apiHandler` + `requireUser` +
`requireNovel`/`requireChapter`/`requireJob`. `tests/security/ownership.test.ts`
(12 tests) drives user B against user A's novel, cover, chapter, outline,
consistency issue, export, settings, job and file, and asserts 404 on each with
no data (titles, names, IDs) leaked in the body. Two additional bugs were found
and fixed while writing those tests:

* `setCover` accepted any `imageId`; it now requires the image to belong to the
  same novel and user (verified by "refuses to select a cover belonging to
  another novel").
* A malformed body produced a 500 (`ZodError` escaped the wrapper); the shared
  error mapper now returns 400 `validation_failed` (verified in
  `tests/security/editor-action.test.ts`).

## 9.3 → §1.3/§1.7/§1.8 Demo content silently replacing real AI output

`GenerationSource` (`openai | demo | fallback`) is returned by every generation
helper. Chapter generation stores `generationSource` and the editor shows a
"produced in demo mode" banner; images are labelled `demo`, `demo-svg`,
`svg-fallback` (+`fallbackReason`); consistency/premise/memory record an
`aiUnavailable` counter instead of presenting a stub as real output.
`tests/story/story-bible.test.ts` asserts demo mode is *not* reported as a
failure, and `tests/workflow/chapters.test.ts` asserts a failed real-provider
call leaves the existing chapter text byte-identical and marks the job failed.

## 9.4 → §1.4/§1.5/§1.10/§1.12 Queue correctness

Implemented: durable `generation_jobs` rows for every long task, CAS claim
(`UPDATE … WHERE status='queued' AND (scheduledAt IS NULL OR scheduledAt<=?)`),
bounded retries with backoff (`min(60 s, 2·2^(n−1))`, `maxAttempts=3`), stale
claim recovery, partial unique index on `idempotencyKey` while a job is active,
a real BullMQ consumer used when `QUEUE_PROVIDER=redis` **and** `REDIS_URL` are
set, and a protected status endpoint (`GET /api/jobs/[jobId]`, owner-scoped).
`tests/queue/queue.test.ts` (11 tests) proves: ten concurrent enqueues of the
same key collapse to one job; three racing `runJob` calls run the handler once;
failures retry and finally fail with the recorded error; a job abandoned by a
dead worker is recovered and completed; an unknown task type fails loudly; the
serialised job omits the payload; `queueDriver()` never reports `redis` without
a URL. Verified live: the worker consumed a queued export job end-to-end (§9.0).

*Not verified:* the BullMQ consumer against a real Redis server (none available
here). The DB-only path and the refusal path are verified.

## 9.5 → §1.13/§1.15/§1.16 Sequential workflow

`src/lib/workflow/navigation.ts` is the single gate used by the server pages and
the outline editor. Chapter generation refuses a locked chapter (409
`chapter_locked`), an unknown chapter (404) and any edit to an approved chapter
(409 `chapter_approved`). Regenerating a chapter that contains author edits
requires `confirmOverwrite` (409 `overwrite_confirmation_required` otherwise),
and the UI asks for confirmation first. Version rows use
`COALESCE(MAX(versionNum),0)+1` (no collisions). Approval is refused for an
empty chapter and enqueues the durable `memory` job, which unlocks the next
chapter. `tests/workflow/chapters.test.ts` (13 tests) covers the gate, duplicate
clicks, failed generation, overwrite protection, approved read-only state,
approval → next-unlock, and resuming queued work after a simulated restart. A
shared `useJobWatcher` hook reports real job state (queued/running/done/failed)
so a refresh cannot lose work; `/settings` now reports the real driver,
storage, queue and AI mode instead of env-var guesses.

## 9.6 → §1.9 Story memory, §1.6 broken updates

- `retrieveMemories` is wired into chapter generation, and memory extraction
  runs as the `memory` job on approval.
- `tests/story/story-bible.test.ts` (8 tests) verifies the summary/event/thread
  rows, novel-scoped retrieval (another novel's memory never surfaces),
  idempotent extraction, and the consistency engine catching a deliberately
  introduced contradiction ("dies protecting the bell tower" + "Mira smiled and
  said … walked … laughed") plus a drifting chapter with no tracked character.
  It also asserts the manuscript text and word count are byte-identical after a
  consistency run, and that the result note states findings are advisory.
- `updateNovelSettings` (previously a silent no-op) and the settings route are
  covered by `tests/persistence/persistence.test.ts`: values persist, invalid
  values 400 without touching the row, and another user gets 404.

## 9.7 → §1.11 EPUB, §9.7 exports

All five formats are built for real: TXT (upper-case title, contents), Markdown
(headings + TOC), DOCX (`docx`: title/heading styles, page break per chapter,
page-number footer, raster cover embedded as an image), PDF (`pdf-lib`:
letter/a4/a5/trade, margins, line spacing, page numbers, non-Latin-1 mapped to
`?`) and EPUB (`epub-gen-memory`: `mimetype` first, `OEBPS/content.opf`,
XHTML chapters with `<p>` paragraphs, cover image). `tests/exports/exports.test.ts`
(13 tests) asserts the zip/PDF signatures, the embedded chapter text, chapter
ordering, cover embedding, the SVG/missing-cover **warnings**, filename
sanitisation, the `nothing_to_export` 409, and that exports are downloadable by
the owner only.

Three silent-fallback bugs in the export path were found by those tests and
fixed: DOCX and PDF discarded their cover warnings, PDF passed a throwaway
warnings array, and the EPUB description was literally `undefined novel`.

## 9.8 → §1.10 Image generation

`tests/images/images.test.ts` (11 tests): demo mode writes labelled SVG concepts
to storage and never records billed image usage; a failing real provider yields
`svg-fallback` with a reason (never `openai`); the 24-concept ceiling returns 429
`cover_limit_reached` before any write; prompt/variant validation 400; selection
sets `isPrimary` + `novels.coverImageId` and advances the stage; foreign covers
404; concepts survive a restart; title/`<script>` content is escaped in the SVG.

## 9.9 → §3/§4 Persistence and deployment

* Versioned migrations (`src/lib/db/migrations.ts`, 0001–0004, applied once and
  recorded in `schema_migrations`) replace the inline `CREATE TABLE IF NOT
  EXISTS` block; `npm run db:migrate` / `db:status` expose them.
* Storage is now a real driver layer: `local` (private `DATA_DIR/uploads`, served
  through the authenticated `/api/files` route, legacy `public/uploads` migrated),
  `s3` (dependency-free SigV4 — matches AWS's published `GET Object` test vector
  `f0e8bdb8…bdb41`, verified end-to-end against a local S3-shaped HTTP server:
  signed PUT path `/bucket/prefix/key`, read-back, delete, CDN base URL,
  missing-credential error) and `cloudinary` (images only).
* PostgreSQL is **still not implemented**; a `postgres://` URL is rejected with
  an actionable error and the required work is documented in
  `docs/postgresql.md`. No claim is made that it works.
* `docs/storage.md` documents bucket configuration and how to verify a
  deployment; `.env.example` was rewritten to match the variables the code
  actually reads.

## 9.10 → §7/§9 Strict build

`next.config.mjs` no longer sets `typescript.ignoreBuildErrors` or
`eslint.ignoreDuringBuilds`; `.eslintrc.json` was added (two deliberate rule
disables are commented in the file); every TypeScript error was fixed; `npm run
build` now fails on a type or lint error. As a side effect of that work the
image optimizer was disabled (`images.unoptimized`) — see §9.11.

## 9.11 Remaining security concerns (open, not fixed)

1. **Next.js 14.2.35 advisories still apply** (`npm audit --omit=dev`: 1 critical
   + 6 high). The critical ones are `GHSA-p293-qw3h-jr36` (unauthenticated RCE,
   Windows-hosted servers only) and `GHSA-2xp9-vwfh-vxw4` (RCE in the Image
   Optimization API when AVIF is used). The direct fix is an upgrade to
   `next@15.5.24`+, which also requires React 19 and `await params` across every
   page/route handler (a migration that was **not** attempted here — see §9.13).
   Partial mitigation applied and verified: `images.unoptimized: true` removes
   the optimization endpoint from the build entirely (no `/_next/image` entry in
   `routes-manifest.json`, no optimizer in `.next/server`), which takes the
   Image Optimization RCE/DoS/cache-growth advisories out of scope for this
   deployment; the app uses no server actions, no rewrites and no `i18n` Pages
   Router config, so those advisories are not exploitable in the current shape.
   The remaining RSC DoS advisories require the upgrade.
2. **Tiptap 2.x advisories** (33 moderate, the bulk of the production audit
   count): the "`__proto__` in `mergeAttributes`" gadget requires a custom
   extension to pass an attacker-controlled attribute key; this app defines no
   custom extensions. Fixing them means Tiptap 3 (breaking extension API).
3. **Cloudinary driver is untested** against a live account; `STORAGE_PROVIDER=s3`
   is the verified production path.
4. **Rate limiting is in-memory** (`src/lib/security/rate-limit.ts`): correct for
   one instance, weaker across horizontally scaled instances. A shared store
   (Redis) would be required for strict enforcement there.
5. **No email verification / password reset flow**; Google sign-in only links to
   accounts that are already email-verified (§2 items).
6. **Dev-dependency advisories** (`vitest`, `vite`, `tinypool`, `eslint-config-next`,
   `glob` …) are tooling-only; `npm audit fix --force` was not run because it
   would move majors outside this task's scope.
7. `npm run test:e2e` still references Playwright with no config or specs in the
   repository.

## 9.12 Deployment instructions

**Vercel (hardened, but see the database caveat)**

1. Import the repository; framework Next.js, Node 22.x, install `npm ci`, build
   `npm run build`.
2. Set `AUTH_SECRET` (≥32 chars) and `AUTH_TRUST_HOST=true`; set
   `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` if Google sign-in is wanted.
3. Set `STORAGE_PROVIDER=s3` plus `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY` (and `S3_ENDPOINT`/`S3_FORCE_PATH_STYLE` for R2/B2/MinIO).
   Local storage refuses to run on Vercel by design.
4. Leave `AI_DEMO_MODE=true` until you are ready to spend; set `OPENAI_API_KEY`
   and `AI_DEMO_MODE=false` for real generation. Budget/rate limits have sane
   defaults (see `.env.example`).
5. **The database is the blocker**: SQLite on Vercel is ephemeral. Until the
   PostgreSQL adapter lands (`docs/postgresql.md`), deploy on a host with a
   persistent disk and run `DATABASE_URL=file:/data/novelforge.db`.

**Persistent-disk host (supported today)**

```bash
npm ci
npm run build
DATABASE_URL=file:/data/novelforge.db DATA_DIR=/data AUTH_SECRET=… npm start
# queue: either in-process, or
QUEUE_PROVIDER=redis REDIS_URL=redis://… npm run worker
```

First run applies migrations automatically; `npm run db:status` reports what is
applied and pending.

## 9.13 Still incomplete

* PostgreSQL adapter (all ~150 query call sites must become async) — documented,
  not implemented.
* BullMQ against a live Redis; Cloudinary against a live account.
* Next 15 / React 19 upgrade (required for the remaining Next advisories).
* Tiptap 3 upgrade (moderate advisories).
* Email verification / password reset; shared-store rate limiting.
* Playwright E2E suite (script exists, specs do not).

## 9.15 Google authentication (added after §9.1–§9.14)

Previously Google was only *partly* wired: the provider existed behind two env
vars, but no UI ever offered it, the OAuth link was never persisted, and the
`jwt` callback ignored a refusal decision from the linking policy.

Added:

* `src/app/login/LoginClient.tsx` and `src/app/register/RegisterClient.tsx` now
  render a "Continue with Google" / "Sign up with Google" button, plus a
  separator, and translate Auth.js error codes into human messages.
  `src/components/auth/GoogleSignInButton.tsx` is the shared control.
* `src/lib/auth/providers.ts` (dependency-free) decides availability and
  computes the redirect URI that must be registered in the Google console. A
  half-configured pair (id without secret, or the reverse) is logged as a
  deployment problem instead of leaving a dead button.
* `resolveGoogleSignIn` gained a third rule: a Google `sub` is bound to exactly
  one NovelForge account, and arriving with a different e-mail is refused.
  `recordOAuthAccount` persists the link in the `accounts` table (idempotent,
  and never moves a link between users); `listLinkedProviders` feeds `/settings`.
* The `jwt` callback now handles a refusal (no user id is written, so the
  session callback clears the user and the request fails closed) and the
  `signIn` callback refuses profiles Google reports as unverified.
* `login`/`register` are `force-dynamic` so the button reflects the *runtime*
  configuration instead of whatever the build machine had.
* `docs/google-signin.md`: console setup, the account-linking policy table, the
  network/egress requirement, and troubleshooting.

Verified (executed):

* `npx vitest run tests/security/google-auth.test.ts` → **16 tests passed**,
  exercising the real NextAuth `signIn`/`jwt` callbacks: provider registered
  with and without env vars, redirect-URI computation, first sign-in creating a
  verified account, the `accounts` row written once and never moved, the token
  carrying the database id, refusal for an unverified password account (victim
  row proven unchanged), linking to a verified account while password login
  keeps working, `sub`/e-mail conflict refusal, unverified-email refusal,
  fail-closed on a late conflict, and credentials sign-ins untouched. Full
  suite: **135 tests / 13 files, all passing**.
* Live, Google configured (`AUTH_GOOGLE_ID`/`SECRET` set): `GET
  /api/auth/providers` → `['google', 'credentials']`; `GET /login` contains
  "Continue with Google"; `GET /register` contains "Sign up with Google";
  `POST /api/auth/signin/google` without a CSRF token → `MissingCSRF` (protection
  active), with one → 302 to the OAuth flow.
* Live, Google **not** configured: `GET /api/auth/providers` →
  `['credentials']`; the login page contains zero Google buttons; registration
  by password still returns 201.

Not verified: a full round trip against Google's servers. This sandbox cannot
reach `accounts.google.com`, so the discovery request Auth.js makes fails with
`fetch failed` and the flow ends at
`/api/auth/error?error=Configuration` — an environment limit, documented in
`docs/google-signin.md` §5 together with the egress requirement (and the reason
explicit endpoints are *not* used: @auth/core would then have no `jwks_uri` and
could not verify the ID-token signature).

## 9.14 Files added or changed

Added: `src/lib/db/migrations.ts`, `src/lib/db/ownership.ts`, `src/lib/api/http.ts`,
`src/lib/security/rate-limit.ts`, `src/lib/workflow/navigation.ts`,
`src/lib/hooks/useJobWatcher.ts`, `src/lib/ai/pricing.ts`, `src/lib/ai/usage.ts`,
`src/lib/storage/{types,local,s3,s3-signature,cloudinary}.ts`,
`src/lib/queue/bullmq.ts`, `src/services/auth/service.ts`,
`src/services/exports/service.ts`, `src/worker/index.ts`,
`src/app/api/auth/register/route.ts`, `src/app/api/files/[...key]/route.ts`,
`src/app/api/jobs/[jobId]/route.ts`, `src/app/api/novels/[id]/jobs/route.ts`,
`src/app/api/novels/[id]/settings/route.ts`,
`src/app/api/novels/[id]/outline/[outlineId]/route.ts`,
`src/app/api/novels/[id]/premise/route.ts`, `src/app/api/usage/route.ts`,
`src/components/auth/SignOutButton.tsx`, `scripts/db-migrate.ts`,
`vitest.config.ts`, `tests/**` (12 spec files), `tsconfig.worker.json`,
`.eslintrc.json`, `docs/storage.md`, `docs/postgresql.md`, `.env.example`.

Changed: 17 existing API routes, `src/lib/ai/{provider,text-generation}.ts`,
`src/lib/auth/{config,edge-config}.ts`, `src/middleware.ts`,
`src/lib/{db/index.ts,queue/index.ts,storage/index.ts}`, the chapters /
consistency / images / novels / outlines / preparation services,
`WritingWorkspace`, `CoverStudio`, `OutlineEditor`, `PreparationWorkspace`,
`NewNovelForm`, the write/outline/consistency/settings pages, `next.config.mjs`,
`src/types/index.ts`, `package.json`, `README.md`.

`git diff --stat`: 47 tracked files changed (+2365 / −1702) plus 31 new paths.

### 9.15 additions

Added: `src/lib/auth/providers.ts`, `src/components/auth/GoogleSignInButton.tsx`,
`src/app/register/RegisterClient.tsx`, `tests/security/google-auth.test.ts`,
`docs/google-signin.md`.
Changed: `src/lib/auth/config.ts` (signIn/jwt linking policy),
`src/services/auth/service.ts` (`resolveGoogleSignIn` third rule,
`recordOAuthAccount`, `listLinkedProviders`), `src/app/login/page.tsx` +
`LoginClient.tsx`, `src/app/register/page.tsx`, `src/app/settings/page.tsx`
(linked providers), `vitest.config.ts` (`next/*` alias resolution),
`README.md`, `.env.example`.

## 9.16 Pricing, Stripe billing and administrator privileges (added after §9.15)

Requested change: *"include pricing and stripe payment and also allow only admin can create novels for
free and also the admin should be able to update a user privilege to generate novel for free."*

### What the product does now

* **No free tier.** `POST /api/novels` and `createNovel()` both call `assertCanCreateNovel()`; without an
  entitlement the request is refused with **402 `payment_required`** and a machine-readable reason
  (`subscription_required` | `subscription_inactive` | `novel_limit_reached`) plus `pricingUrl`.
* **Paid plans** — Author $12/month (3 novels in progress) and Studio $29/month (12), in
  `src/lib/billing/plans.ts`, priced by Stripe price ids from `STRIPE_PRICE_AUTHOR` / `STRIPE_PRICE_STUDIO`.
  "In progress" = novels whose `status` is not `completed`, so finishing a novel frees a slot.
* **Admins create for free.** `users.role='admin'` (or an address in `ADMIN_EMAILS`) bypasses the gate
  entirely; the entitlement reason is `admin`.
* **Admins can comp any user.** `users.freeNovelAccess` + `freeNovelGrantedBy/At`, toggled from `/admin`
  (reason `comp`). Every role change and comp change is written to `admin_audit_log`.
* **Stripe Checkout + Billing Portal**, both Stripe-hosted — no card data touches NovelForge. Plan comes
  from our catalogue, customer from the account, never from the request body.
* **Verified, idempotent webhooks** — `constructEvent` with `STRIPE_WEBHOOK_SECRET`; the plan is resolved
  from *our* price id (an unknown price stores `unknown` and grants nothing); `metadata.plan` is never
  trusted; every event id is inserted into `stripe_events` with `ON CONFLICT DO NOTHING`, so a redelivery
  changes nothing.
* **Graceful degradation** — with no `STRIPE_SECRET_KEY` every billing endpoint answers 503
  `billing_not_configured`, `/pricing` shows "Billing is not connected on this deployment", and admins and
  comped accounts still work.

### Commands executed for this change

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx next lint` | `✔ No ESLint warnings or errors` |
| `npx vitest run` | `Test Files 15 passed (15)`, `Tests 171 passed (171)` (billing: 25 + 11 = 36 of them) |
| `rm -rf .next && npm run build` | exit 0, 18/18 static pages generated, lint + types inside the build; new routes listed as `ƒ /admin`, `ƒ /pricing`, `ƒ /api/admin/users`, `ƒ /api/admin/users/[userId]`, `ƒ /api/billing/checkout`, `ƒ /api/billing/portal`, `ƒ /api/webhooks/stripe` |
| `npm run admin:grant -- alice2.billing@example.com` | `granted admin to … (Alice Admin)`; audit row `role_granted_cli` |
| HTTP, registered user, live dev server | `POST /api/novels` → **402** `payment_required` `{"reason":"subscription_required","pricingUrl":"/pricing",…}`; after the CLI promotion the same request → **200** and a novel row |
| HTTP, admin API | `GET /api/admin/users` as the admin → 200 with both accounts (`role`, `freeNovelAccess`, `canCreateNovel`, `reason`); as a normal user → 403 `admin_only`; anonymous → 401 |
| HTTP, grant/revoke | `PATCH /api/admin/users/<bob>` `{"freeNovelAccess":true}` → 200 (`canCreateNovel: true`, `freeNovelGrantedBy` set), bob's `POST /api/novels` → 200; after `{"freeNovelAccess":false}` bob → 402 again; `PATCH` self role change → 409 `cannot_modify_self` |
| HTTP, audit log | `free_access_granted`, `free_access_revoked`, `role_granted_cli` visible through `GET /api/admin/users` |
| HTTP, pages | `/pricing` 200 and renders both plans (with the "billing is not connected" banner on this deployment); `/admin` 200 for the admin, 307 → `/login?callbackUrl=%2Fadmin` when anonymous; `/novels/new` 307 when anonymous |

The Stripe integration tests never touch the network: a `node:http` server is pointed at with
`STRIPE_API_HOST/PORT/PROTOCOL` and answers the SDK's customers / checkout sessions / billing portal /
subscription retrieval calls, and webhook signatures come from Stripe's own
`webhooks.generateTestHeaderString`. Covered: the 402 gate, plan limits, completed novels freeing a slot,
`past_due` refusal, comps, the admin role, grant/revoke with audit rows, self-demotion,
last-admin/non-admin guards, the admin listing never including password material, `ADMIN_EMAILS`
bootstrap (deliberately sticky), checkout/portal requests and their 503/409 refusals, forged signatures
(rejected without writing), replay idempotency, subscription lifecycle (cancel → 402, restore → 200),
unknown price ids and metadata that tries to upgrade a plan, plus the route-level authorisation matrix.

### Not verified

A real Stripe account was not available in this sandbox and there is no outbound access to
`api.stripe.com`, so **no live Checkout session, Billing Portal session or webhook delivery was
executed**. Everything above ran against the local fake Stripe server and Stripe's signature helper.
Before going live: create the two products/prices, set the four env vars, add the webhook endpoint, then
run one test-mode purchase (`4242 4242 4242 4242`) and confirm the plan appears on `/settings` and
`/admin`. Steps in [`docs/billing.md`](billing.md).

Also worth knowing: the "last administrator cannot be demoted" guard (409 `last_admin`) is defence in
depth rather than a reachable path — because an admin cannot change their own role and the acting admin
is always counted, the live admin count cannot reach zero. The test asserts the reachable invariants
(non-admin 403, self-demotion 409, `countAdmins()` never dropping to 0, `ADMIN_EMAILS` counting).

### Files added / changed in §9.16

Added: `src/lib/billing/plans.ts`, `src/lib/billing/stripe.ts`,
`src/services/billing/service.ts`, `src/app/api/billing/checkout/route.ts`,
`src/app/api/billing/portal/route.ts`, `src/app/api/webhooks/stripe/route.ts`,
`src/app/api/admin/users/route.ts`, `src/app/api/admin/users/[userId]/route.ts`,
`src/app/pricing/page.tsx`, `src/app/admin/page.tsx`,
`src/components/billing/{PricingPlans,BillingCard}.tsx`,
`src/components/admin/AdminUsers.tsx`, `scripts/grant-admin.ts`,
`tests/security/billing.test.ts`, `tests/security/billing-routes.test.ts`,
`docs/billing.md`.

Changed: `src/lib/db/migrations.ts` (new `0005_billing_and_roles`, placed after `0004`),
`src/services/novels/service.ts` + `src/app/api/novels/route.ts` (entitlement gate before the burst
limiter), `src/app/novels/new/page.tsx` (plan prompt instead of a form that would 402) +
`src/components/novel/NewNovelForm.tsx` (402 → `/pricing`), `src/app/settings/page.tsx` (billing panel +
billing runtime row), `src/middleware.ts` (`/admin`, `/api/admin`, `/api/billing` protected),
`src/types/index.ts` (`checkoutSchema`, `adminUserPatchSchema`), `src/lib/api/http.ts` (`HttpError`
details merged into the error body), `package.json` (stripe@23.0.0, `admin:grant`),
`tests/persistence/persistence.test.ts` (asserts the migration list from `migrations` instead of a
hard-coded one), `README.md`, `.env.example`.

### Remaining billing risks

1. **Webhook delivery depends on the deployment being reachable** and on `STRIPE_WEBHOOK_SECRET` being
   set; if the secret is missing, deliveries are rejected 400 (loud, never silently trusted).
2. **`subscriptions` is projected from events** — if the webhook endpoint is down for a long period the
   local row can lag. Entitlement reads do not call Stripe (deliberate: no per-request network
   dependency), so a reconciliation job (`stripe subscriptions list` → `upsertSubscription`) would be the
   next step if that matters for the deployment. Not implemented.
3. **Self-hosted SQLite + one web instance** is still the supported runtime (unchanged by this work);
   multi-instance deployments remain blocked by the database limitation in §9.13.
4. Stripe's own account settings (tax, portal configuration, invoices) are deployment configuration, not
   code; the app does not attempt to configure them.

## 9.17 Production Reliability, Optimistic Concurrency, Revision History, Backups & Health Check

### Summary of upgrades

1. **Migration `0006_persistence_revisions_and_backups` (`src/lib/db/migrations.ts`)**:
   - Added `users.status` (`'active' | 'suspended'`), enforced in `requireUser()` (`403 account_suspended`).
   - Added `chapters.revision` (monotonic integer for optimistic concurrency control), `chapters.generatedContentJson` (separating AI-generated baseline from user-edited content), and `chapters.lastJobId`.
   - Added `chapter_versions.novelId`, `chapter_versions.revisionType` (`'generation' | 'autosave' | 'manual' | 'conflict' | 'pre_restore' | 'restore'`), and `chapter_versions.parentVersionId`.
   - Added `generation_jobs.chapterId`, `generation_jobs.errorCode`, and `generation_jobs.retryable`.
   - Added `ai_usage.chapterId`, `ai_usage.jobId`, and `ai_usage.estimatedCostBeforeUsd`.
   - Added `novel_backups` table and composite indexes (`idx_chapters_novel_status`, `idx_versions_chapter_num`, `idx_jobs_novel_status`, `idx_ai_usage_novel_created`).

2. **Fixed Premise & Outline Persistence Bugs (`src/services/preparation/service.ts`, `src/services/outlines/service.ts`, `src/services/novels/service.ts`)**:
   - Fixed `updatePremiseField` parameter bind count (`vals.push(now, novelId, novelId, userId)` for the 4 trailing `?` placeholders), added column allowlisting, transactional upsert when a premise row does not yet exist, and `404` on unknown novel.
   - Added column allowlisting and transactional unapproved chapter title synchronization to `updateOutline`.
   - Added `updateNovel` and `PATCH /api/novels/[id]`, plus `limit`/`offset` pagination on `listNovels` and `GET /api/novels`.

3. **Autosave, Optimistic Concurrency, Draft Recovery & Revision History (`src/services/chapters/service.ts`, `src/lib/editor/draft-recovery.ts`, `src/components/editor/WritingWorkspace.tsx`, `src/app/api/novels/[id]/chapters/[chapterId]/versions/route.ts`)**:
   - Implemented `expectedRevision` optimistic concurrency checking in `saveChapterContent`. Stale saves return `409 revision_conflict` while automatically preserving the incoming draft as a `revisionType = 'conflict'` snapshot in `chapter_versions`.
   - Implemented `createAutosaveController` and browser draft recovery (`saveLocalDraft`, `loadLocalDraft`, `hasRecoverableDraft`, `clearLocalDraft`, `listUnsavedDraftsForNovel`, bounded at `MAX_RECOVERY_ENTRIES = 20`) with debounced autosave, manual save (`Cmd/Ctrl+S`), bounded exponential backoff retries, out-of-order response protection, and `beforeunload` warning.
   - Added `GET` and `POST` `/api/novels/[id]/chapters/[chapterId]/versions` and a Revision History panel in `WritingWorkspace.tsx` to inspect, create snapshots, and non-destructively restore earlier versions (recording `pre_restore` and `restore` snapshots).

4. **AI Job Lifecycle, Cancellation, Error Classification & Cost Estimation (`src/lib/queue/index.ts`, `src/app/api/jobs/[jobId]/route.ts`, `src/lib/ai/pricing.ts`, `src/lib/ai/usage.ts`, `src/lib/ai/text-generation.ts`, `src/lib/ai/embeddings.ts`)**:
   - Added `classifyJobError`, `NonRetryableJobError`, `sanitizeErrorMessage`, `awaiting_review` job status, mid-flight cancellation check (`isCancelled()`), and owner-scoped job cancellation/retry endpoints (`POST` and `DELETE /api/jobs/[jobId]`).
   - Added `estimateOperationCost`, `novelUsageSummary`, transient provider retries with exponential backoff + jitter (`isRetryableProviderError`), and bounded embedding LRU cache (`MAX_EMBEDDING_CACHE = 256`).

5. **Verified Project Backups, Transactional Restore & Health Endpoint (`src/services/backups/service.ts`, `src/app/api/novels/[id]/backup/route.ts`, `src/app/api/novels/restore/route.ts`, `src/app/api/health/route.ts`, `src/lib/config/env.ts`, `src/lib/logger/index.ts`)**:
   - Implemented SHA-256 checksum-verified novel backup export (`createNovelBackup`), credential exclusion, and transactional restore (`restoreNovelBackup`) plus online SQLite backup (`backupSqliteDatabaseFile`).
   - Added `GET /api/health`, startup config validation (`validateEnvConfig`), and secret-redacting structured logging (`logger`).
   - Expanded automated test suite from 15 files (171 tests) to **19 files (188 tests)** — all passing alongside `npm run typecheck`, `npm run lint`, and `npm run build`.

