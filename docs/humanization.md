# Humanization integration status

NovelForge now exposes `GET /api/ai/humanize` (authenticated) for model-registry metadata and `POST /api/ai/humanize` for a preview proposal. Requests must include an owned `novelId` and passage text. The response includes original/revised text, mode, provider, token usage when provided, latency, and a basic proper-noun review warning. The endpoint does not save or silently apply a proposal; the original manuscript remains authoritative.

The service is separate from general novel generation and routes rewriting through the selected Hugging Face model using the Hugging Face Inference Providers OpenAI-compatible chat API. `HUGGINGFACE_HUMANIZER_MODEL` selects the default (GoHumanize candidate); `HUMANIZATION_PROVIDER` optionally pins a provider (default `auto`); `HF_TOKEN` is required and remains server-side. No fallback to another model occurs. Missing credentials, provider failure, and malformed model output are returned as errors while preserving the source text.

Three instruction modes (light, natural, deep), optional custom instructions, and bounded context are supported. This is instruction-following, not a guarantee that each model has independently verified mode capabilities. The service currently accepts individual passages up to 30,000 characters. Chapter/n novel batch orchestration, durable proposals, user preferences, automatic post-generation processing, pause/resume, and diff-based acceptance are not yet implemented.

## Registry verification

The extensible registry lists 20 candidate entries: 10 requested dedicated humanizer candidates and 10 general-purpose rewrite alternatives. **Verified: 0; live inference tested: 0.** Every row is explicitly `unverified`; license, size, hosting eligibility, language claims beyond the intended English UI, and pricing are intentionally not inferred from repository names. These entries are candidates, not operational promises. The pre-existing `npm run ai:verify` verifies configured general model registry entries; it does not certify this dedicated registry. Verify each candidate's Hub model card, license, provider mapping, input contract, and a successful inference in the target account before marking it usable in production. Hugging Face hosted availability and cost depend on provider/account terms and are not assumed free.

## Setup and testing

Set `HF_TOKEN` and optionally `HUGGINGFACE_HUMANIZER_MODEL` / `HUMANIZATION_PROVIDER` in the server environment. Never put these values in browser environment variables. Routine test suites should mock the provider. No live call was made as part of this implementation because no inference credentials were available. See [AI inference](AI_INFERENCE.md) for the existing provider client and policy configuration.
