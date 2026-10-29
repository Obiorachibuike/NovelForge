# NovelForge

> **Build your story. Write your world. Publish your novel.**
>
> The AI prepares the novel, the author controls the story, and NovelForge remembers everything that matters.

NovelForge is a production-quality AI-powered novel-writing and digital publishing studio. It takes a novel from **Title → Cover → Preparation → Story Bible → Outline → Sequential Writing → Synchronization → Consistency → Export**, generating **one chapter at a time** under the author's explicit approval.

## Features

- **Next.js 14 App Router** with React Server Components, TypeScript, Tailwind CSS, Framer Motion, Lucide, TanStack Query.
- **Auth.js v5** with credentials + optional Google OAuth.
- **Subscriptions & administration** — no free tier: novel creation requires an active Stripe plan, the
  administrator role, or free access granted by an administrator. Stripe Checkout + Billing Portal +
  signature-verified, idempotent webhooks, with role and comp changes audited. See [`docs/billing.md`](docs/billing.md).
- **Tiptap** rich-text editor with debounced autosave, manual save (`Cmd/Ctrl+S`), optimistic concurrency control (`expectedRevision`) with automatic conflict preservation, supplementary browser draft recovery (compare/restore/discard), full revision history with non-destructive restore, word counts, and selection-based AI editing.
- **Agnes AI as the primary provider (text + image)** — `agnes-2.5-flash` for prose, outlines, structured JSON and editor actions; `agnes-image-2.5-flash` for covers, with tier/aspect-ratio image sizing and Base64 or URL output. Set `AGNES_API_KEY` and it becomes the main AI power for both modalities.
- **Hosted inference on Hugging Face as the fallback** — 50 text-to-text and 20 text-to-image models configured in a database-backed registry, with repository/provider verification, bounded task-compatible fallback, per-model circuit breakers, output validation, cost-status accounting (`confirmed` / `estimated` / `unknown`) and an administrator model console at `/admin/ai`. When Agnes AI fails (or an HF model is explicitly chosen), the request automatically continues down the Hugging Face chain. Availability and pricing are only ever reported from evidence that was actually collected. See [`docs/AI_INFERENCE.md`](docs/AI_INFERENCE.md) and [`MODEL_STATUS.md`](MODEL_STATUS.md).
- **Structured AI layer** with provider interface, streaming, structured JSON output (Zod-validated), embeddings with bounded LRU cache, pre-operation cost estimation, per-user/novel/chapter/job cost tracking, and transient error retries with exponential backoff + jitter. Works in **demo mode** with deterministic placeholder content when no API key is set.
- **Sequential writing engine** — only one chapter unlocked at a time; explicit approval unlocks the next. Failure recovery via persisted job records, error classification (`retryable` vs permanent), and user-initiated job cancellation/retry (`POST/DELETE /api/jobs/[jobId]`).
- **Story Bible** — characters, locations, world rules, timeline events, plot threads; updated automatically after chapter approval.
- **Story memory** with embeddings (OpenAI or a deterministic stub in demo mode) for retrieval-augmented chapter generation.
- **Consistency engine** — heuristic + AI checks for timeline clashes, dead characters appearing, word-count targets, world-rule violations.
- **Exports & Project Backups** — manuscript exports to DOCX, PDF, TXT, Markdown and EPUB (with unsaved local draft warnings), plus SHA-256 checksum-verified full novel JSON backup export (`GET /api/novels/[id]/backup`), transactional non-destructive restore (`POST /api/novels/[id]/backup` and `POST /api/novels/restore`), and online SQLite database backup (`backupSqliteDatabaseFile`).
- **Health & Observability** — `GET /api/health` readiness endpoint, startup configuration validation (`src/lib/config/env.ts`), and secret-redacting structured logging (`src/lib/logger/index.ts`).
- **Queue abstraction** — in-process runner by default; a real BullMQ consumer when `QUEUE_PROVIDER=redis` *and* `REDIS_URL` are set, plus a database poller and stale-job recovery in `npm run worker`.
- **Cloudinary cover-image storage** — cover candidates are generated as temporary previews; when the author selects a cover, NovelForge validates the image binary/SVG content, uploads only the selected cover to Cloudinary under `novelforge/covers/<user-id>/<novel-id>/cover_<image-id>`, stores `secure_url` and `public_id` in PostgreSQL, cleans up orphaned assets on DB rollback, and deletes superseded covers on replacement. See [`docs/storage.md`](docs/storage.md).
- **PostgreSQL primary database** — PostgreSQL via `pg` (`Pool`, `PoolClient`) with connection pooling, transactions (`BEGIN`/`COMMIT`/`ROLLBACK`), versioned migrations (`0001`–`0007`), and a non-destructive, idempotent SQLite-to-PostgreSQL migration tool (`npm run db:migrate:sqlite-to-pg`). Production requires `DATABASE_URL=postgresql://...` and never silently falls back to SQLite. See [`docs/postgresql.md`](docs/postgresql.md).

## Quick start (local development)

Requires **Node.js 22.x**.

```bash
npm ci
cp .env.example .env.local    # defaults to SQLite (file:./prisma/dev.db) — no database server needed
npm run db:migrate
npm run dev
```

Open http://localhost:3000. Register with any email/password — no external services required. In demo mode, stylized SVG covers and deterministic chapter text are used.

Local development uses a SQLite file; **production requires PostgreSQL** (`DATABASE_URL=postgresql://…`) and `AUTH_SECRET`. The app refuses to fall back to SQLite in production — see [Troubleshooting](#troubleshooting-login-or-register-fails) if sign-in answers with an error.

### Environment Variables & Services

Configure the following in `.env` / `.env.local`:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | **Primary PostgreSQL connection string** (`postgresql://user:password@host:5432/novelforge`). Required in production (never silently falls back to SQLite). |
| `STORAGE_PROVIDER=cloudinary` | Uses Cloudinary for permanent selected novel cover storage (`src/services/covers/cloudinary-cover-service.ts`). |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Server-only Cloudinary credentials for cover upload, replacement, and cleanup. |
| `OPENAI_API_KEY` | Enables real AI text, structured output, embeddings, and (if model supports) image generation |
| `AGNES_API_KEY` | **Agnes AI API key (primary provider)** — powers text (`agnes-2.5-flash`) and image (`agnes-image-2.5-flash`) generation. Server-side only. Get one at [platform.agnes-ai.com](https://platform.agnes-ai.com) |
| `AGNES_TEXT_MODEL` / `AGNES_IMAGE_MODEL` / `AGNES_BASE_URL` | Optional Agnes overrides (defaults: `agnes-2.5-flash`, `agnes-image-2.5-flash`, `https://apihub.agnes-ai.com/v1`) |
| `HF_TOKEN` | Hugging Face token with *Inference Providers* permission. **Fallback provider**: 50 text + 20 image models that serve requests when Agnes AI fails (or the primary backend when Agnes is unset). Server-side only — see [`docs/AI_INFERENCE.md`](docs/AI_INFERENCE.md) |
| `AI_BACKEND` | `auto` (default: Agnes if `AGNES_API_KEY`, else Hugging Face if `HF_TOKEN`, else OpenAI, else demo) · `agnes` · `huggingface` · `openai` |
| `AI_ALLOW_PAID_INFERENCE` / `AI_REQUIRE_CONFIRMED_PRICING` | Pricing guardrails for hosted inference (default `false` / `true`) |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth (both required) - see [`docs/google-signin.md`](docs/google-signin.md) |
| `AUTH_SECRET` | **Required in production** (≥32 chars). The app refuses production requests with a placeholder or missing secret. |
| `QUEUE_PROVIDER=redis` + `REDIS_URL` | Turns on the BullMQ consumer (run `npm run worker`); otherwise jobs run in-process. |
| `STORAGE_PROVIDER=s3` + `S3_*` | Persistent S3-compatible object storage for exports/files. |
| `DATA_DIR` | Local file location for `STORAGE_PROVIDER=local` and temporary cover candidate previews (default `.data/`). |
| `AI_DAILY_TOKEN_LIMIT` / `AI_MONTHLY_COST_LIMIT_USD` | Per-user spend guards enforced from the `ai_usage` table. |

### Troubleshooting: `/login` or `/register` fails

Sign-in and registration are the first requests that touch the database, so a
bad `DATABASE_URL` (or a missing `AUTH_SECRET`) shows up there first. The server
never returns a bare `500 Internal server error` for these any more: it answers
`503` with a `code` and a `hint` that name the cause (credentials in the URL are
never echoed back).

```bash
curl -s localhost:3000/api/health | jq   # live diagnosis: error, code, hint, database.target
```

| Symptom | `code` | Cause & fix |
| --- | --- | --- |
| "Nothing is accepting connections…" | `database_unreachable` | No PostgreSQL at that host/port. Start it (`docs/postgresql.md`), or use `DATABASE_URL="file:./prisma/dev.db"` for zero-setup local development. |
| "Production requires a PostgreSQL DATABASE_URL…" | `database_configuration` | `NODE_ENV=production` with a `file:`/missing URL. Point `DATABASE_URL` at `postgresql://…`, or set `ALLOW_SQLITE_IN_PRODUCTION="true"` intentionally. |
| "The database rejected the credentials" | `database_authentication` | Wrong user/password in `DATABASE_URL` (SQLSTATE 28P01). |
| "…schema is missing" | `database_missing_schema` | Reachable database without tables (SQLSTATE 42P01): run `npm run db:migrate`. |
| "TLS certificate could not be verified" | `database_ssl` | Managed provider with its own CA: set `PG_SSL="no-verify"` (or install the provider CA). |
| `?error=Configuration` on `/login`, register still works | — | `AUTH_SECRET` is missing, a placeholder, or shorter than 32 chars. Generate one with `openssl rand -base64 48`. |

The server log carries the full classification, e.g.
`[api] database error (unreachable/ECONNREFUSED at 127.0.0.1:5432/novelforge): …`
or `[auth] sign-in blocked by a database problem (…). <hint>`.

### Database & Migration Commands

```bash
# Apply pending schema migrations (PostgreSQL or SQLite)
npm run db:migrate

# Inspect applied and pending migrations
npm run db:status

# Non-destructively migrate existing SQLite records into PostgreSQL
DATABASE_URL="postgresql://user:password@localhost:5432/novelforge" \
  npm run db:migrate:sqlite-to-pg -- --sqlite ./prisma/dev.db
```

Run a dedicated worker (for Redis / BullMQ mode):

```bash
npm run worker
```

## Project structure

```
src/
  app/                     Next.js App Router pages and route handlers
    (studio)/              Protected app layout (dashboard + novel workspaces)
    api/                   Route Handlers for novels, chapters, AI actions, export
  components/
    auth/                  Client sign-out button
    dashboard/, novel/     Novel cards, create form, headers
    editor/                Tiptap editor workspace
    story-bible/           Preparation + Bible views
    outline/               Outline editor
    ai/                    Model selector used by the preparation and cover surfaces
    admin/                 Admin console (users, AI models)
    visuals/               Cover studio
    consistency/           Consistency checker
    export/                Export UI
    layout/                Sidebar / headers
  lib/
    ai/                    Provider-agnostic AI layer (text/structured/embeddings/usage/pricing/prompts)
                             + hosted inference: config, huggingface-client, error-classifier,
                               retry-policy, circuit-breaker, output-validation, model-selection,
                               model-registry, model-verification, fallback-orchestrator,
                               usage-tracker, rate-limit, model-report
    api/                   Route-handler wrapper, error mapping, body limits
    auth/                  Auth.js config (node) + edge config used by middleware
    db/                    SQLite data layer, versioned migrations, ownership helpers
    hooks/                 Client hooks (durable job watcher)
    queue/                 Durable job store + in-process drainer + BullMQ consumer
    security/              Per-user/IP rate limiting
    storage/               local / s3 (SigV4) / cloudinary drivers
    workflow/              Sequential-writing gate (shared by server and client)
    utils/                 cn, formatters, words-to-pages, hash
  services/
    novels/                Core novel/settings/progress service
    images/                Cover generation (hosted inference / OpenAI images with labelled SVG fallback)
    preparation/           Premise + Story Bible initial generation
    outlines/              Story structure + chapter outline generation
    chapters/              Sequential writing, autosave, versions, approval, summary memory
    memory/                Embedding-based story memory retrieval
    consistency/           AI + heuristic continuity checks
    exports/               DOCX / PDF / TXT / Markdown / EPUB
  worker/                  Standalone worker entrypoint
```

## Workflow implementation status

- [x] Registration & login (credentials, plus Google OAuth with safe account linking - [`docs/google-signin.md`](docs/google-signin.md))
- [x] Novel creation wizard (title, genre, targets, mode)
- [x] Cover generation (OpenAI images when configured; SVG fallbacks in demo)
- [x] Primary cover selection → advances stage
- [x] Novel preparation (premise, synopsis, themes, setting, characters, world rules, timeline)
- [x] Story Bible tabs (overview, characters, locations, world rules, timeline, plot threads)
- [x] Story structure + complete chapter outline generation with word budgets
- [x] Outline approval gate
- [x] **Sequential chapter generation** — next chapter locked until previous approved
- [x] Tiptap editor with toolbar, autosave, word counts, placeholder, formatting
- [x] Versioning on snapshot
- [x] Chapter summary, character/thread/timeline/world-rule extraction on approval
- [x] Story memory retrieval with cosine/keyword hybrid search
- [x] Selection-based AI editor actions (continue, rewrite, expand, shorten, improve, dialogue)
- [x] Consistency engine with heuristics + AI analysis
- [x] Export to DOCX, PDF, TXT, Markdown **and EPUB** (validated in `tests/exports`)
- [x] Responsive premium dark-themed UI, accessible controls
- [x] Job persistence, atomic claiming, bounded retries with backoff, idempotency keys, stale-job recovery
- [x] Ownership checks on every protected route (covered by cross-user tests)
- [x] Pricing page, Stripe Checkout/Portal and verified webhooks; administrators and comped accounts create novels for free
- [x] Admin console for roles and per-user free-access grants, with an audit log
- [x] Explicit demo vs. real AI separation, with degraded runs labelled instead of silently substituted
- [x] **Agnes AI primary provider** for text (`agnes-2.5-flash`) and image (`agnes-image-2.5-flash`) generation, with the hosted Hugging Face chain (50 text + 20 image models, registry, verification, bounded task-compatible fallback, circuit breakers, cost-status accounting, admin model console) as the automatic fallback
- [x] Per-artefact model provenance (which model was requested and which one actually answered, on jobs, usage rows and cover assets)
- [ ] PostgreSQL adapter (see `docs/postgresql.md`)
- [ ] Live Redis/BullMQ and Cloudinary runs (code present; not exercised against live services here)

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Next.js dev server (port 3000, binds 0.0.0.0) |
| `npm run build` | Production build |
| `npm run start` | Serve production build |
| `npm run worker` | Run the background worker (in-process or BullMQ when REDIS_URL is set) |
| `npm run lint` / `typecheck` | Lint & type check |
| `npm test` | Run Vitest unit tests |
| `npm run admin:grant -- <email> [--revoke]` | Promote (or demote) an administrator account |
| `npm run ai:verify` | Verify every configured Hugging Face model (Hub metadata + provider mapping; `--smoke` adds a tiny live text call) |
| `npm run ai:models:report` | Regenerate `MODEL_STATUS.md` and `docs/model-status.json` from stored verification results (no network) |

## Verification

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # next lint (no warnings)
npm test              # 339 Vitest tests across 31 files
npm run build         # production build with type + lint validation enabled
npm run db:migrate    # apply pending SQLite migrations non-destructively
npm run db:status     # inspect applied and pending SQLite migrations
npm run worker        # standalone worker (migrations, poller, BullMQ when configured)
npm run ai:verify     # verify hosted-inference Hugging Face models (requires HF_TOKEN; Agnes AI needs no verification)
```

Coverage highlights: cross-user isolation for every API route and stored file,
registration / login / Google-linking policy (16 tests), atomic job claiming and retry/recovery,
the sequential-writing gate and overwrite protection, exports for all five
formats, story-memory extraction and consistency heuristics, image demo/fallback
labelling, S3 signing against AWS's published test vector, restart durability
for novels, settings, chapters, covers, jobs and exports, and billing
(entitlement gate, plan limits, comps, admin grants and audit rows, checkout and
portal calls, webhook signature verification and replay idempotency) against a
local Stripe-shaped server — 36 of those tests; no live Stripe call was made.

Hosted inference adds 107 tests (`tests/ai/*`) that run against an injected
`fetch`, so no test touches the network and no test spends provider credits:
model registry and the exact 70 configured IDs; text and image generation
success and every failure class; bounded, task-correct fallback; circuit
breakers, retries and per-user rate limits; Hub/router verification verdicts;
the full story-bible → outline → chapter → cover workflow with model provenance;
and API security (authentication, admin-only actions, model-id validation, no
token in any response).

## Production deployment notes

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full deployment runbook, including
the hosted-inference configuration (`HF_TOKEN`, verification, worker, timeouts).

The default runtime targets a **persistent, single-instance Node.js server**:
SQLite needs a writable disk (`DATABASE_URL=file:/data/novelforge.db`), files live
under `DATA_DIR`, and the queue runs in-process. For multi-instance or
serverless hosts, object storage (`STORAGE_PROVIDER=s3`) is implemented and
verified; the database constraint is documented in
[`docs/postgresql.md`](docs/postgresql.md), and Redis/BullMQ is wired but has not
been exercised against a live Redis here. Setting an environment variable does
not by itself enable any adapter — each one either works or refuses loudly.

### Verifying the AI provider after deploying

Adding `AGNES_API_KEY` in the hosting dashboard does not change a deployment that
already exists: variables are captured when a deployment is built, so redeploy
first. Then:

- `GET /api/health` → `ai.backend` is the backend that will serve the next
  request, and `ai.providers` says whether each credential is present in that
  process (`"missing"` there means the wrong environment scope or a stale
  deployment).
- `/admin/ai` → **Overview** → **Live provider test** makes one real, tiny Agnes
  AI request and reports the model, the latency and a classified failure reason
  (`not_configured`, `authentication_failed`, `model_not_found`, `disabled`).

Full detail: [`docs/AI_INFERENCE.md` § 1b](docs/AI_INFERENCE.md) and
[`DEPLOYMENT.md` § 3.1a](DEPLOYMENT.md).

### Vercel build configuration

- Select **Next.js** as the framework, repository root as the root directory,
  **Node.js 22.x**, install command `npm ci`, and build command `npm run build`.
- The build is `next build` only. There is no Prisma schema/client in this app;
  SQLite tables are initialized by `src/lib/db/index.ts` on first database use.
- Redeploy the branch containing this fix, preferably without the old build cache.
- Set a strong `AUTH_SECRET` in each deployment environment.
- Billing is optional but, without it, only administrators and accounts an administrator comped can
  create novels. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_AUTHOR` and
  `STRIPE_PRICE_STUDIO`, point a webhook at `https://<domain>/api/webhooks/stripe`, and set
  `ADMIN_EMAILS` to bootstrap the first administrator. Steps: [`docs/billing.md`](docs/billing.md).
- `vercel.json` pins the settings above for projects that leave their dashboard fields
  on defaults. **Project-level settings always win**, so a project created while this
  repository was still a Vite app keeps its stale framework preset and build command —
  no repository change can override it. See
  [`docs/vercel-deployment-failure-investigation.md`](docs/vercel-deployment-failure-investigation.md).
- Persistent object storage is **required** on Vercel: set `STORAGE_PROVIDER=s3`
  (see [`docs/storage.md`](docs/storage.md)). Local file generation explicitly
  refuses to run there.
- SQLite on Vercel is ephemeral, so a managed database adapter is still needed
  before the studio can be used on Vercel — see
  [`docs/postgresql.md`](docs/postgresql.md). Do not use `/tmp` SQLite as durable storage.
- `npm run build` now runs TypeScript and ESLint validation; the previous
  `ignoreBuildErrors` / `ignoreDuringBuilds` flags were removed.
- The production-readiness audit, including the remaining gaps, lives in
  [`docs/production-readiness-audit.md`](docs/production-readiness-audit.md).

## The guiding principle

**The AI prepares the novel, the author controls the story, and NovelForge remembers everything that matters.**

## Email verification, one-time codes and password recovery

Sign-in is allowed even before the e-mail is verified: an unverified account
logs in normally and its profile page (Settings) shows a warning that links
into the verification flow. All transactional email is delivered by **Brevo** through one client
([`src/lib/email/brevo.ts`](src/lib/email/brevo.ts)); see
[`docs/email.md`](docs/email.md) for the full contract.

- `BREVO_API_KEY` — server-only Brevo API key (SMTP & API → API Keys).
- `MAIL_FROM` — verified Brevo sender, for example `NovelForge <no-reply@your-domain.example>`.
- `NEXT_PUBLIC_APP_URL` (or `NEXTAUTH_URL`) — canonical application URL used to create action links.

Each verification and reset message contains **two** single-use secrets: a secure
link (one hour) and a **six-digit one-time code** (ten minutes, five attempts).
The link is consumed by `/verify-email` or `/reset-password`; the code works from
any device via `POST /api/auth/verify-email` (`{ email, code }`) or
`POST /api/auth/reset-password` (`{ email, code, password }`). Only hashes are
stored — SHA-256 for link tokens, bcrypt for codes — and the attempt counter is
incremented before each comparison, so codes cannot be brute-forced in parallel.

Registration sends the verification message. The sign-in page offers verification
resend, the code entry page and a forgot-password link. Request responses do not
reveal whether an account exists. If email delivery is missing or unavailable,
registration is retained and sign-in still works — the profile page keeps
showing the unverified warning until the user requests a new verification
email after delivery is configured. Without `BREVO_API_KEY` in
development, the link and code are printed to the server console instead of being
sent. `GET /api/health` reports `email.configured`; setting `BREVO_API_KEY`
without a usable `MAIL_FROM` fails startup validation immediately.

The additive migrations `0010_auth_recovery_tokens` and `0011_auth_otp_codes`
store only hashes of link tokens and codes. Run the normal migration procedure
(`npm run db:migrate`) before deploying. Do not log or expose raw links, codes or
email-provider credentials.
