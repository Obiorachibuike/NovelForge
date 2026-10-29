# Hosted inference (Agnes AI primary · Hugging Face fallback) — architecture, operations and honest status

This document describes how NovelForge generates text and images through hosted
inference: **Agnes AI is the primary provider for both text and image**, the
Hugging Face Inference Providers chain is the fallback, and how models are
verified, selected and recovered when a provider fails. What is **not** claimed
is stated explicitly.

Status of every Hugging Face model: [`MODEL_STATUS.md`](../MODEL_STATUS.md)
(regenerate with `npm run ai:models:report`, or after a verification run with
`npm run ai:verify`).

---

## 1. What was built

NovelForge has a provider layer with three real backends and a deliberate order:

```
Agnes AI (AGNES_API_KEY)      → primary for text AND images
   └── fails → Hugging Face (HF_TOKEN) hosted models, task-compatible chain
                  └── fails → labelled fallback / demo / OpenAI (unchanged)
```

Nothing that worked before was removed: the Hugging Face chain, the OpenAI
backend, demo mode, the job queue, the editor, the export pipeline and the
billing gates are unchanged. Agnes AI is attempted first whenever
`AGNES_API_KEY` is set; a failed Agnes call automatically continues on the
Hugging Face chain, and the response metadata (`source`, `provider`,
`actualModelId`) always records where the output really came from.

```
UI (ModelSelector)                 Admin console (/admin/ai)
        │                                   │
        ▼                                   ▼
/api/ai/models/*   /api/ai/generate/*   /api/admin/ai/*
        │                                   │
        ▼                                   ▼
 text-generation.ts ──► agnes-generation.ts ──► agnes-client.ts  ← holds AGNES_API_KEY
        │                   (Agnes primary)        (apihub.agnes-ai.com/v1)
        └─ failure ──► hf-text-generation.ts  image-generation.ts
                          └──► fallback-orchestrator.ts   model-verification.ts
                                 · selection (model-selection.ts)   model-registry.ts
                                 · retries + backoff (retry-policy.ts)
                                 · circuit breakers (circuit-breaker.ts)
                                 · output validation (output-validation.ts)
                                 · usage/cost accounting (usage-tracker.ts)
                                        ▼
                               huggingface-client.ts   ← the only place that holds HF_TOKEN
```

Key files:

| File | Responsibility |
| --- | --- |
| `src/lib/ai/config.ts` | Backend resolution and policy (`aiPolicy()`), token access, config validation |
| `src/lib/ai/agnes-client.ts` | Agnes AI HTTP client (chat completions, images/generations, tier+ratio sizing) |
| `src/lib/ai/agnes-generation.ts` | Agnes text / structured / image generation with bounded retries |
| `src/lib/ai/models.ts` | The 50 text + 20 image Hugging Face model IDs, categories, static limitations |
| `src/lib/ai/huggingface-client.ts` | Dependency-free HF HTTP client (chat, images, Hub metadata, router catalog) |
| `src/lib/ai/error-classifier.ts` | Maps every failure to a category, HTTP status and availability verdict |
| `src/lib/ai/retry-policy.ts` | Bounded retries with exponential backoff and `Retry-After` support |
| `src/lib/ai/circuit-breaker.ts` | Per-model breakers so a broken model cannot eat the fallback budget |
| `src/lib/ai/output-validation.ts` | Rejects empty/prompt-echo text and non-image payloads |
| `src/lib/ai/model-selection.ts` | Scores, filters and orders candidates; validates caller-supplied IDs |
| `src/lib/ai/fallback-orchestrator.ts` | Runs the bounded, task-compatible fallback chain and records provenance |
| `src/lib/ai/model-registry.ts` | Persistence for registry rows, events and metrics |
| `src/lib/ai/model-verification.ts` | Hub/router verification and optional live smoke tests |
| `src/lib/ai/usage-tracker.ts` | Usage rows with `costStatus` (confirmed / estimated / unknown) |
| `src/lib/ai/rate-limit.ts` | Per-user hourly budgets for hosted text and image requests |
| `src/lib/ai/model-report.ts` | `MODEL_STATUS.md` and `docs/model-status.json` generators |

### 1a. Agnes AI specifics

- Endpoint: `https://apihub.agnes-ai.com/v1` (OpenAI-compatible), key from the
  [Agnes AI console](https://platform.agnes-ai.com).
- Text model: `agnes-2.5-flash` (chat completions, `response_format` JSON
  supported; plain-text retry + JSON extraction when a request rejects the
  parameter).
- Image model: `agnes-image-2.5-flash` via `POST /v1/images/generations`.
  Requests use the documented tier + ratio form (`size: "1K"` … `"4K"` with
  `ratio: "1:1" | "3:4" | "4:3" | "16:9" | "9:16" | "2:3" | "3:2" | "21:9"`);
  requested pixel dimensions are mapped to the closest documented pair
  (`nearestAgnesSize`). Base64 output is requested through both documented
  mechanisms (`return_base64: true` and
  `extra_body.response_format: "b64_json"` — never a top-level
  `response_format`, which the docs call out as an error); a URL response is
  also supported and downloaded. Reference images for image-to-image are passed
  through `extra_body.image` (public URLs or data URIs).
- Pricing used for budgeting: the published *list* prices (`agnes-2.5-flash`
  $0.05/$0.15 per 1M in/out tokens, image 1K $0.01 per image) even though the
  current promoted price is $0, so cost estimates stay conservative. Override
  per deployment with `AI_PRICE_*` environment variables.

---

### 1b. Proving a provider is live (deployment-level diagnostics)

Configuration is not evidence. Two surfaces report what the *running* process
actually sees, and both are secret-free:

| Surface | What it answers |
| --- | --- |
| `GET /api/health` → `ai` | Which backend the next request uses (`backend`), whether each credential is present (`providers.agnes` / `.huggingface` / `.openai`), and configuration problems by variable **name** only (`problems`). |
| `POST /api/admin/ai/providers/test` (admin only) | Makes one real, minimal Agnes AI request (`{"provider":"agnes","kind":"text" \| "image"}`) and returns `ok`, `model`, `latencyMs`, a short `sample` (text) or `imageBytes`, or a classified `error.category`. |

`src/lib/ai/config.ts#aiProviderSummary()` is the single source for the provider
order (`agnes → huggingface → openai`), the pinned backend and the per-provider
status; `src/lib/ai/provider-diagnostics.ts#testAgnesProvider()` performs the
live test. Neither function returns a key, a `Bearer` header or a raw provider
error body.

Failure categories worth knowing:

- `not_configured` — `AGNES_API_KEY` is not visible to this deployment: wrong
  environment scope, or the deployment predates the variable (variables are
  captured at build time — redeploy).
- `authentication_failed` — the key reached Agnes AI and was rejected (revoked,
  mistyped, or from another account).
- `model_not_found` — the account cannot use `AGNES_TEXT_MODEL` /
  `AGNES_IMAGE_MODEL`; override the model id.
- `disabled` — an image test was requested without
  `AI_ALLOW_LIVE_IMAGE_HEALTH_CHECKS=true`.

---

## 2. Endpoints used

| Purpose | Endpoint | Notes |
| --- | --- | --- |
| Text generation (Agnes, primary) | `POST {AGNES_BASE_URL}/chat/completions` | OpenAI-compatible chat with `agnes-2.5-flash`. |
| Image generation (Agnes, primary) | `POST {AGNES_BASE_URL}/images/generations` | `agnes-image-2.5-flash`, tier `size` + `ratio`, Base64 preferred. |
| Text generation (HF) | `POST {HF_ROUTER_BASE_URL}/chat/completions` | OpenAI-compatible chat. Provider auto-selection with automatic failover by the router. |
| Image generation | `POST {HF_ROUTER_BASE_URL}/images/generations` | OpenAI-compatible images (`response_format: b64_json`). |
| Image generation (fallback transport) | `POST {HF_ROUTER_BASE_URL}/{provider}/models/{providerId}` | Provider-native task route, used when the OpenAI-compatible images route is not available for the model. |
| Repository metadata | `GET {HF_HUB_API_BASE_URL}/models/{id}?expand[]=inferenceProviderMapping&…` | Existence, gating, license, pipeline tag, provider mapping, adapter metadata. |
| Router catalog | `GET {HF_ROUTER_BASE_URL}/models/{id}` | Provider status, context length and pricing. |

Defaults: `HF_ROUTER_BASE_URL=https://router.huggingface.co/v1`,
`HF_HUB_API_BASE_URL=https://huggingface.co/api`.

The client is deliberately dependency-free: it speaks the documented HTTP API
with `fetch`, so there is no deprecated SDK to inherit.

---

## 3. Configuration

Add to `.env.local` (server-side only — never `NEXT_PUBLIC_*`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGNES_API_KEY` | — | **Agnes AI API key — the primary text and image provider.** Placeholder values (`your`, `replace`, `agnes_your`, `xxx`) are treated as unset. |
| `AGNES_BASE_URL` | `https://apihub.agnes-ai.com/v1` | Agnes AI API base URL |
| `AGNES_TEXT_MODEL` | `agnes-2.5-flash` | Agnes chat model |
| `AGNES_IMAGE_MODEL` | `agnes-image-2.5-flash` | Agnes image model |
| `HF_TOKEN` | — | Fine-grained Hugging Face token with **Inference Providers** permission (the fallback chain behind Agnes; the primary backend when Agnes is unset). Placeholder values (`your`, `replace`, `hf_your`, `xxx`) are treated as unset. |
| `AI_BACKEND` | `auto` | `auto` (Agnes if key, else HF if token, else OpenAI, else demo) · `agnes` · `huggingface` · `openai` |
| `HF_ROUTER_BASE_URL` | `https://router.huggingface.co/v1` | Router base URL |
| `HF_HUB_API_BASE_URL` | `https://huggingface.co/api` | Hub metadata base URL |
| `HF_PROVIDER` | `auto` | Pin a provider (`hf-inference`, `fal-ai`, `together`, …) or let the router choose |
| `HF_DEFAULT_TEXT_MODEL` | `Qwen/Qwen2.5-7B-Instruct` | Fallback default when no model is requested |
| `HF_DEFAULT_IMAGE_MODEL` | `black-forest-labs/FLUX.1-schnell` | Fallback default for covers |
| `AI_IMAGE_TRANSPORT` | `auto` | `auto` · `openai-compatible` · `task-native` |
| `AI_FALLBACK_ENABLED` | `true` | Master switch for automatic model fallback |
| `AI_MAX_FALLBACK_ATTEMPTS` | `4` | Hard cap on models tried per request |
| `AI_MAX_RETRIES_PER_MODEL` | `1` | Retries per model for transient errors |
| `AI_REQUEST_TIMEOUT_MS` | `120000` | Per-request deadline |
| `AI_ALLOW_PAID_INFERENCE` | `false` | Allow models confirmed as paid |
| `AI_REQUIRE_CONFIRMED_PRICING` | `true` | Skip models whose pricing is unknown |
| `AI_MODEL_HEALTH_CHECK_ENABLED` | `true` | Allow registry verification |
| `AI_MODEL_HEALTH_CHECK_INTERVAL_HOURS` | `24` | How long a stored verification result stays fresh |
| `AI_MODEL_CACHE_TTL_SECONDS` | `3600` | In-process cache for verification results |
| `AI_MAX_TEXT_REQUESTS_PER_USER_PER_HOUR` | `20` | Per-user hosted text budget (`0` disables) |
| `AI_MAX_IMAGE_REQUESTS_PER_USER_PER_HOUR` | `5` | Per-user hosted image budget (`0` disables) |
| `AI_MAX_CONCURRENT_REQUESTS` | `2` | Concurrency cap for hosted calls |
| `AI_ALLOW_LIVE_IMAGE_HEALTH_CHECKS` | `false` | Allow live image smoke tests (spends credits) |
| `AI_MAX_IMAGE_EDGE` | `1024` | Clamp for requested width/height |
| `AI_MAX_COMPLETION_TOKENS` | `8000` | Upper bound for generated tokens |

`validateEnvConfig()` reports configuration problems (for example an `HF_TOKEN`
that does not start with `hf_`, or a rejected `HF_PROVIDER`) at startup instead
of surfacing them as a confusing runtime failure.

### Defaults are conservative on purpose

With `AI_REQUIRE_CONFIRMED_PRICING=true` (the default), a model whose pricing is
**unknown** is not eligible. Because a fresh registry marks all 70 models as
`unverified`/`unknown`, **run `npm run ai:verify` once after setting `HF_TOKEN`**;
until then the honest answer is "no model has been confirmed". Setting
`AI_REQUIRE_CONFIRMED_PRICING=false` relaxes this and lets unverified models be
tried, which is useful on a personal account where you accept the risk.

---

## 4. Model registry, verification and selection

### Registry

Migration `0008_hf_model_registry` creates `ai_model_registry` (one row per
configured model) and `ai_model_events` (verification and inference events).
Rows are seeded on first use; re-seeding never overwrites evidence that has
already been collected.

Each row carries: task, category, provider, `availabilityStatus`,
`pricingStatus`, license, context length, supported sizes, limitations, adapter
metadata, verification source, latency and success/failure counters, `enabled`,
`isPrimary` and `disabledReason`.

**Availability states**: `verified` is never used as a label for "ready". The
states are `available`, `unavailable`, `unsupported`, `authentication_required`,
`paid_only`, `rate_limited`, `temporarily_unavailable`, `unknown` and
`unverified`. Only `available` (or a live success) is treated as operational.

### Verification

`npm run ai:verify` runs, per model:

1. **Hub metadata** — does the repository exist, is it gated, what pipeline tag
   and license does it declare, which providers are mapped and with what status?
2. **Router catalog** — provider status, context length and pricing.
3. **Optional live smoke test** — a tiny text inference (`Reply with the single
   word: OK`). Image smoke tests only run when
   `AI_ALLOW_LIVE_IMAGE_HEALTH_CHECKS=true`, because they spend credits and are
   slow; administrators can also trigger one from the console.

Verdicts are recorded, never invented:

- repository missing on both Hub and router → `unavailable`
- gated repository → `authentication_required`
- pipeline tag incompatible with the task (`text-to-image` vs
  `text-generation`) → `unsupported`
- adapter/LoRA weights published instead of a standalone pipeline →
  `unsupported` plus adapter metadata
- no provider, or providers not `live` → `unavailable`
- provider mapping present and live → `available`
- **the Hub and the router could not be reached at all** → `unknown`, *not*
  `unavailable` (a network problem is never reported as "the model does not
  exist")

Pricing comes from provider pricing data. Zero pricing → `free`; non-zero →
`paid`; nothing published → `unknown`, which is never treated as free.

### Selection

For each request, `selectModels()` builds an ordered, task-correct candidate
list:

1. models that are **disabled** by an administrator are skipped (with their
   reason exposed in the UI and in the error message);
2. models whose availability the policy forbids (unavailable, unsupported,
   gated, paid-only when paid inference is off) are skipped;
3. models whose pricing is unknown are skipped when confirmed pricing is
   required;
4. models whose context window is smaller than the request are skipped;
5. image models that cannot render the requested size are skipped;
6. candidates are scored by verification strength, historical success rate,
   latency, price, primary status, minus a penalty for an open circuit breaker.

The writer's explicit choice is always attempted first; the rest of the chain is
only used for fallback. A primary model is a **scoring bonus, not a hard pin** —
it can still fail and be replaced.

---

## 5. Failure handling

`orchestrateGeneration()` runs one request:

```
for each candidate (bounded by AI_MAX_FALLBACK_ATTEMPTS):
    if circuit open → skip
    run with retries (bounded by AI_MAX_RETRIES_PER_MODEL) + deadline
    validate the payload (non-empty text; real image bytes)
    on success → record success, usage, provenance → return
    on failure → classify → record failure event + availability → next model
auth failure → stop immediately (credentials apply to every model)
no candidate succeeded → HTTP 503 with the models tried and the skip reasons
```

Rules that are enforced in code and covered by tests:

- **Text never falls back to image and image never falls back to text.** The
  candidate list is filtered by task before the chain is built.
- **Attempts are bounded.** `AI_MAX_FALLBACK_ATTEMPTS` ×
  (`AI_MAX_RETRIES_PER_MODEL` + 1) requests, each with a hard deadline. There is
  no unbounded loop and no unbounded concurrency.
- **Permanent failures are not retried.** Authentication/permission errors stop
  the chain after one attempt.
- **Nothing is fabricated.** A failed generation fails the job. NovelForge never
  writes stub prose or a placeholder image as if it were generated output; where
  a substitute concept is offered for a cover it is stored with
  `provider='svg-fallback'`, `source='svg-fallback'` and the provider's reason,
  and the UI labels it.
- **Every failure message ends with actionable guidance**: "Check model
  availability, access permissions and pricing settings in Admin → AI models."
- **Image responses are validated.** An HTTP 200 carrying JSON, an error body or
  an undersized payload is rejected and the next image model is tried.

### Error taxonomy

| Category | HTTP | Retry | Availability verdict |
| --- | --- | --- | --- |
| `authentication_failed` | 403 | no | `authentication_required` |
| `permission_denied` / `gated_model` | 403 | skip model | `authentication_required` |
| `paid_inference_required` / `quota_exceeded` | 402 | skip model | `paid_only` |
| `rate_limited` | 429 | yes | `rate_limited` |
| `model_not_found` | 503 (skip model) | skip model | `unavailable` |
| `unsupported_task` / `provider_unsupported` | 503 (skip model) | skip model | `unsupported` |
| `timeout` | 504 | yes | `temporarily_unavailable` |
| `network_error` | 503 | yes | `unknown` |
| `provider_outage` | 503 | yes | `temporarily_unavailable` |
| `invalid_image` / `malformed_output` / `empty_output` | 503 (skip model) | skip model | `unknown` |
| `content_policy` | 400 | no | `unavailable` |
| `invalid_request` | 400 | no | `unknown` |

---

## 6. Cost honesty

Every generation writes a row to `ai_usage` with
`costStatus ∈ {confirmed, estimated, unknown}`:

- **confirmed** — the provider reported the cost for this request;
- **estimated** — cost computed from the provider's published price list and the
  token counts reported by the provider;
- **unknown** — no pricing information; `estimatedCostUsd` is stored as `0` and
  the row is flagged, so totals never silently mix known and unknown spend.

`GET /api/admin/ai/usage` reports `unknownCostRequests` separately from priced
requests, and the per-user spend limits in `src/lib/ai/usage.ts` remain the
cross-instance control.

---

## 7. Security

- `HF_TOKEN` is read **per request** from `process.env` inside
  `huggingface-client.ts`. It is never stored on a module-level constant, never
  logged, never returned from any function, and never sent to the browser. No
  route returns it (asserted in `tests/ai/api-security.test.ts`).
- Model IDs in request bodies are validated against the registry
  (`assertRegisteredModel`). The generation endpoints can therefore never be used
  as an open proxy to arbitrary Hugging Face repositories.
- All endpoints require authentication; the model console and every mutating
  model action additionally require the `admin` role.
- Error bodies are redacted before leaving the client: provider messages are
  classified and replaced with safe, actionable text.
- Per-user hourly budgets (`AI_MAX_TEXT_REQUESTS_PER_USER_PER_HOUR`,
  `AI_MAX_IMAGE_REQUESTS_PER_USER_PER_HOUR`) sit on top of the existing
  per-endpoint limiter to protect a shared quota.
- Images are persisted through the existing storage drivers; binary image data is
  never stored in the database (only URL, key, format, bytes and provenance).

---

## 8. Operations

```bash
# Repository + provider-mapping verification for every configured model (no inference)
npm run ai:verify

# Also run a tiny live text inference per eligible model (spends a little)
npm run ai:verify:smoke

# One model only
npm run ai:verify -- --model=Qwen/Qwen2.5-7B-Instruct --smoke

# Image models only
npm run ai:verify -- --task=image

# Regenerate MODEL_STATUS.md + docs/model-status.json from stored results (no network)
npm run ai:models:report
```

The **Admin → AI models** console (`/admin/ai`) shows overview counts, the
active policy, usage, recent failures, and lets an administrator verify or smoke
test a model, enable/disable it with a reason, and set or clear the primary
model for a task. Verification is never triggered implicitly by a page load:
listing the catalogue makes zero provider calls.

Writers pick a model in the preparation and cover surfaces with the
`ModelSelector` component, which shows availability, pricing, provider, latency
and the primary marker, and never labels a model "ready" — only "Unverified",
"Available" or the specific reason it is not usable.

---

## 9. What is **not** claimed

- **All 70 model IDs are configured, not proven.** Presence in the registry only
  means the ID is part of the requested list; it does not mean a provider serves
  it, that the account may use it, or that it is free. Run
  `npm run ai:verify` and read `MODEL_STATUS.md` for the evidence.
- **Gated repositories** (Llama, Gemma, FLUX.1-dev, SD3.5, …) require the
  account to accept the model terms on Hugging Face before inference is
  possible.
- **Adapter/LoRA repositories** (`XLabs-AI/flux-RealismLora`,
  `ByteDance/SDXL-Lightning`) publish weights for a base model, not standalone
  pipelines. NovelForge records the adapter metadata and marks the model
  unsupported for direct calls; it does not silently compose base + adapter.
- **Cascaded pipelines** (`DeepFloyd/IF-I-XL-v1.0`) return a low-resolution
  stage-I image from a single hosted call.
- **Pricing marked `unknown` is unknown**, never free.
- **No text-to-video.** The scope is text-to-text and text-to-image only.
- Verification depends on outbound access to `huggingface.co` and
  `router.huggingface.co`. Where that access is blocked, every model stays
  `unverified`/`unknown` and `MODEL_STATUS.md` says so explicitly — it does not
  guess.

---

## 10. Testing

`tests/ai/*` covers the hosted-inference layer with an injected `fetch`
(`__setFetchForTests`); no test touches the network or spends credits:

| File | Covers |
| --- | --- |
| `registry.test.ts` | the exact 50 + 20 IDs, categories, seeding, enable/disable/primary, metrics, overview counts |
| `text-generation.test.ts` | successful generation, auth failure, missing/unsupported model, rate limits, timeouts, network errors, empty and malformed output, pricing policy |
| `image-generation.test.ts` | OpenAI-compatible and task-native transports, HTTP-200 error bodies, undersized payloads, gated/unsupported models, task purity, dimension clamping, cover service provenance |
| `fallback.test.ts` | selection scoring and skip reasons, bounded attempts, circuit breakers, retry/backoff, per-user rate limits |
| `verification.test.ts` | Hub/router mapping to availability and pricing, gating, missing repos, adapters, task mismatch, network failure → unknown, live-test promotion |
| `novel-workflow.test.ts` | story bible → outline → chapter → cover end to end, provenance, sequential gate, edits and regeneration, honest failures, retry |
| `api-security.test.ts` | authentication, admin-only actions, model-id validation, no token in responses, per-user limits, catalogue makes no provider calls |
