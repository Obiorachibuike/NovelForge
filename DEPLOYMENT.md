# Deployment

How to run NovelForge in production, including the hosted-inference
(Hugging Face) layer. For the internals of that layer see
[`docs/AI_INFERENCE.md`](docs/AI_INFERENCE.md); for the evidence-backed status of
each model see [`MODEL_STATUS.md`](MODEL_STATUS.md).

---

## 1. Runtime shape

NovelForge is a **persistent, single-instance Node.js server**. It is not a
stateless function:

- SQLite (development) or PostgreSQL (production) needs a writable, durable
  disk/connection — see [`docs/postgresql.md`](docs/postgresql.md).
- Uploads and generated files live under `DATA_DIR` (or S3/Cloudinary — see
  [`docs/storage.md`](docs/storage.md)).
- Background generation runs through the durable job store
  (`generation_jobs`) plus the worker (`npm run worker`) and/or the in-process
  drainer.

**Serverless platforms with short request timeouts are a bad fit for
generation**: a chapter call can legitimately take tens of seconds. If you must
run on one, keep the web tier free of generation work by running the standalone
worker on a long-lived host, and raise the platform's function timeout to at
least `AI_REQUEST_TIMEOUT_MS`.

Minimum: **Node.js 22.x**.

---

## 2. Required configuration

| Variable | Production value |
| --- | --- |
| `DATABASE_URL` | `postgresql://…` (SQLite is refused in production unless `ALLOW_SQLITE_IN_PRODUCTION=true`) |
| `AUTH_SECRET` | `openssl rand -base64 48` (≥32 chars; a placeholder makes every sign-in fail) |
| `NEXTAUTH_URL` / `NEXT_PUBLIC_APP_URL` | Public HTTPS origin |
| `ADMIN_EMAILS` | Comma-separated emails promoted to administrator on sign-in |
| `BILLING_REQUIRED` | `true` unless you intentionally bypass subscriptions |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | Billing (see [`docs/billing.md`](docs/billing.md)) |
| `BREVO_API_KEY` | Brevo transactional-email API key (SMTP & API → API Keys) |
| `MAIL_FROM` | Verified Brevo sender, e.g. `NovelForge <no-reply@your-domain.example>` |

Storage, Redis/queue and Google sign-in are optional; each adapter either works
or refuses loudly — setting a variable alone never enables an adapter.

### Transactional email (Brevo)

Sign-up requires a verified address, so email delivery is **required in
production**. Add a Brevo API key, verify your sending domain/address under
*Senders* in Brevo, and set `MAIL_FROM` to that sender.

- Every message is sent through `POST https://api.brevo.com/v3/smtp/email`
  (`api-key` header) — see [`docs/email.md`](docs/email.md).
- Verification and password-reset messages carry **both** a one-hour, single-use
  link and a **six-digit one-time code valid for ten minutes** (five attempts).
- Only hashes are stored: SHA-256 for link tokens, bcrypt for codes.
- `GET /api/health` reports `email.configured`. If `BREVO_API_KEY` is set but
  `MAIL_FROM` is not a valid address, startup validation fails immediately
  instead of failing mid-registration.
- `BREVO_SENDER_EMAIL` / `BREVO_SENDER_NAME` are optional fallbacks used only
  when `MAIL_FROM` is unset.

---

## 3. Hosted inference (Agnes AI primary · Hugging Face fallback)

### 3.1 Credentials

**Agnes AI (primary — text and images).** Create an API key in the
[Agnes AI console](https://platform.agnes-ai.com) and put it in `AGNES_API_KEY`
on the server only. With this one key, `agnes-2.5-flash` generates all text
(chapters, outlines, premises, structured JSON, editor actions) and
`agnes-image-2.5-flash` generates all covers:

```bash
AGNES_API_KEY="…"
AI_BACKEND="auto"          # Agnes AI when AGNES_API_KEY is set
```

**Hugging Face (fallback).** Create a **fine-grained Hugging Face user access
token** with the *Make calls to Inference Providers* permission and put it in
`HF_TOKEN`. Its hosted models serve a request when Agnes AI fails, and are the
primary backend when `AGNES_API_KEY` is absent:

```bash
HF_TOKEN="hf_…"
AI_BACKEND="auto"          # Agnes → Hugging Face → OpenAI → demo
```

Rules that the code enforces:

- Each key is read per request inside `src/lib/ai/agnes-client.ts` /
  `src/lib/ai/huggingface-client.ts`. Keys are never logged, never returned by
  an API route, and never included in a client bundle (`server-only` + no
  `NEXT_PUBLIC_*` usage).
- Placeholder keys (`your…`, `replace…`, `hf_your…`, `agnes_your…`, `xxx…`) are
  treated as unset, so a copy-pasted template can never silently switch a
  backend on.
- Without any key the app stays on the OpenAI or demo backend and every model in
  `/admin/ai` is reported as **Unverified** — which is the truth, because nothing
  has been checked.

### 3.1a Verifying the key in the running deployment

A variable in the hosting dashboard and a variable the running code can see are
two different facts. Environment variables are captured when a deployment is
**built**, so adding `AGNES_API_KEY` does not change a deployment that already
exists — redeploy (or push to the production branch) first. Then check, in this
order:

1. `GET /api/health` → the `ai` block names the backend that will serve the next
   request and whether each credential is present in *this* process:

   ```json
   "ai": {
     "backend": "agnes",
     "mode": "agnes",
     "providers": { "agnes": "configured", "huggingface": "missing", "openai": "missing" },
     "problems": []
   }
   ```

   `backend: "demo"` with `providers.agnes: "missing"` means the key is not in
   this environment (wrong scope, or a deployment built before it was added).
   `backend: "huggingface"` can only happen when `AGNES_API_KEY` is unset or the
   placeholder guard rejected it.

2. `/admin/ai` → **Overview** → **Live provider test** → *Test text*. This makes
   one real, tiny request and reports the model, the latency and, on failure,
   the classified reason (`authentication_failed` = key rejected,
   `not_configured` = key absent from this deployment, `model_not_found` =
   model id not available to the account, `disabled` = live image tests are off).
   *Test image* additionally requires `AI_ALLOW_LIVE_IMAGE_HEALTH_CHECKS=true`
   because it spends credits.

3. Generate one chapter. Every response carries `source` / `provider` /
   `actualModelId`, so the provenance says whether Agnes answered or the
   fallback chain did.

`AGNES_API_KEY` should be scoped to **Production, Preview and Development**
unless you deliberately want previews on the fallback chain.

### 3.2 Network egress

The server needs outbound HTTPS access to:

- `apihub.agnes-ai.com` — Agnes AI text and image generation
  (`/v1/chat/completions`, `/v1/images/generations`)
- `router.huggingface.co` — generation (`/v1/chat/completions`,
  `/v1/images/generations`, provider-native task routes, `/v1/models/{id}`)
- `huggingface.co` — repository metadata (`/api/models/{id}`)

If egress is blocked, verification reports `unknown` (never "the model does not
exist") and generation fails with `network_error` after the configured retries.

### 3.3 Verify before you rely on it

```bash
npm run db:migrate
npm run ai:verify            # Hub metadata + provider mapping for all 70 models
npm run ai:models:report     # write MODEL_STATUS.md + docs/model-status.json
```

`npm run ai:verify` performs repository and provider-mapping checks only; it
does **not** run inference. Add `--smoke` to send one tiny live text request per
eligible model. Image smoke tests need
`AI_ALLOW_LIVE_IMAGE_HEALTH_CHECKS=true` because they spend credits and are
slow.

Verification results are cached (`AI_MODEL_CACHE_TTL_SECONDS`, default 1 h) and
re-used while they are within `AI_MODEL_HEALTH_CHECK_INTERVAL_HOURS` (default
24 h). Loading a page never triggers verification and never sends requests to
70 models: the catalogue is served from the database.

### 3.4 Pricing guardrails

The defaults are deliberately conservative:

```bash
AI_ALLOW_PAID_INFERENCE="false"      # never call a model confirmed as paid
AI_REQUIRE_CONFIRMED_PRICING="true"  # skip models whose pricing is unknown
```

Because a fresh registry marks every model `unverified`/`unknown`, **run
`npm run ai:verify` before going live**, or set
`AI_REQUIRE_CONFIRMED_PRICING=false` if you accept the risk on a personal
account. Paid models stay skipped while `AI_ALLOW_PAID_INFERENCE=false`, and a
`402` from a provider is recorded as `paid_only` and moves the request to the
next eligible model.

Costs are recorded per request with `costStatus ∈ {confirmed, estimated,
unknown}`. Unknown pricing is stored as `0` but flagged, and the admin usage
endpoint reports `unknownCostRequests` separately, so totals never mix known and
unknown spend. The per-user spend limits (`AI_DAILY_TOKEN_LIMIT`,
`AI_MONTHLY_COST_LIMIT_USD`) remain in force.

### 3.5 Per-user budgets

```bash
AI_MAX_TEXT_REQUESTS_PER_USER_PER_HOUR="20"
AI_MAX_IMAGE_REQUESTS_PER_USER_PER_HOUR="5"
AI_MAX_CONCURRENT_REQUESTS="2"
```

These sit on top of the existing per-endpoint limiter and protect a shared
quota. `0` disables a limit.

---

## 4. Gated models, adapters and other realities

- **Gated repositories** (Llama, Gemma, FLUX.1-dev, SD3.5 …) require the account
  to accept the model's terms on huggingface.co before inference is possible.
  NovelForge reports them as *access required* rather than pretending they are
  broken.
- **Adapter/LoRA repositories** (`XLabs-AI/flux-RealismLora`,
  `ByteDance/SDXL-Lightning`) publish weights for a base model, not a standalone
  pipeline. They are recorded as unsupported for direct calls, with their
  adapter metadata shown in the console; NovelForge does not silently compose
  base + adapter.
- **Cascaded pipelines** (`DeepFloyd/IF-I-XL-v1.0`) return a low-resolution
  stage-I image from a single hosted call.
- **Unknown pricing is unknown**, never free.

---

## 5. Process layout

```bash
npm ci
npm run build
npm run db:migrate          # apply migrations (PostgreSQL or SQLite)

# Web
npm run start               # serves the production build (port 3000 by default)

# Worker (recommended in a separate process/container, same DATABASE_URL)
npm run worker              # polls the durable job store; BullMQ when REDIS_URL is set
```

Two processes are safe: job claiming is an atomic compare-and-set `UPDATE`, and
stale jobs are recovered after `QUEUE_STALE_JOB_MS` (default 5 min), so the
BullMQ consumer, the database poller and an in-process dispatch can run
concurrently without executing the same job twice.

Health: `GET /api/health` reports database connectivity, foreign keys, the latest
migration, queue state and configuration validation.

---

## 6. Migration notes

Migrations `0008_hf_model_registry` and `0009_generation_provenance` are
additive (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN`) and
idempotent:

- `ai_model_registry`, `ai_model_events`
- `generation_jobs.requestedModel/actualModel/provider/fallbackCount/durationMs`
- `ai_usage.requestedModel/actualModel/attemptCount/fallbackCount/durationMs/costStatus/confirmedCostUsd/imageWidth/imageHeight`
- `image_assets.model/requestedModel`
- `chapters.modelRequested/modelUsed`

Run `npm run db:migrate` (or `npm run db:status`) after deploying. Existing rows
are preserved; registry rows are seeded on first use.

---

## 7. Operational checklist

1. `npm run typecheck && npm run lint && npm test && npm run build`
2. `npm run db:migrate` against the production database
3. Set `AGNES_API_KEY` (primary) and optionally `HF_TOKEN` (fallback), server-side only; run `npm run ai:verify` to verify the Hugging Face fallback models
4. Skim `/admin/ai`: disable models that are unavailable for your account, set a
   primary model per task, and confirm pricing states
5. `npm run ai:models:report` and commit the refreshed `MODEL_STATUS.md`
6. Watch `/api/admin/ai/failures` after the first real generations; a model that
   fails repeatedly is skipped by its circuit breaker and shown in the console

---

## 8. Security checklist

- `HF_TOKEN` never leaves the server; no route returns it (covered by
  `tests/ai/api-security.test.ts`)
- Model IDs from request bodies are validated against the registry, so the
  generation endpoints cannot be used as an open proxy to arbitrary Hugging Face
  repositories
- All AI routes require authentication; the model console and every mutating
  model action require the `admin` role
- Per-user hourly budgets plus the existing per-endpoint limiter
- Images are stored through the storage drivers; binaries are never written to
  the database
- Provider error bodies are classified and redacted before they reach a client
- Do not run paid inference in CI: the test suite injects a fake `fetch`, and
  `AI_ALLOW_PAID_INFERENCE=false` in test environments
