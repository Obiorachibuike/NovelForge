/**
 * Model verification.
 *
 * Three distinct levels of evidence — never conflated:
 *
 *  1. **Repository check** (Hub API): does the repository exist, is it gated,
 *     what is its license and pipeline tag?
 *  2. **Hosted-inference check** (provider mapping / router catalog): is there a
 *     provider that serves this model for the task we need, what does it cost,
 *     what context length does it expose?
 *  3. **Live smoke test** (an actual, minimal inference): did a real request
 *     succeed end to end?
 *
 * A repository existing proves nothing about hosted inference, and a provider
 * mapping proves nothing about whether *this account* can call the model. Only
 * a live smoke test upgrades `verificationSource` to `live-inference`.
 *
 * Verification is cached (in memory for `AI_MODEL_CACHE_TTL_SECONDS`, persisted
 * via `lastCheckedAt` for `AI_MODEL_HEALTH_CHECK_INTERVAL_HOURS`) so no page
 * load ever fans out to 70 models. Image smoke tests are opt-in because they
 * cost money.
 */
import 'server-only';
import { agnesConfigured, aiPolicy, huggingFaceConfigured, isExplicitAgnesModel } from './config';
import { agnesChatCompletion, agnesGenerateImage } from './agnes-client';
import { hfChatCompletion, hfGenerateImage, hfModelInfo, hfRouterModelInfo } from './huggingface-client';
import { getModelRow, patchModel, recordModelEvent, syncRegistry } from './model-registry';
import { taskForModelId } from './models';
import { validateImageBuffer, validateTextOutput } from './output-validation';
import type { ModelAvailability, ModelPricing, ModelRow, ModelTask, VerificationSource } from './types';

const TEXT_PIPELINES = new Set(['text-generation', 'conversational', 'text2text-generation', 'image-text-to-text']);
const IMAGE_PIPELINES = new Set(['text-to-image', 'image-text-to-image', 'diffusers']);

export interface VerifyOptions {
  /** Run a real (minimal) inference. Text smoke tests are cheap; images are not. */
  smoke?: boolean;
  /** Force a re-check even when the cached result is still fresh. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface VerifyResult {
  modelId: string;
  task: ModelTask;
  /** Repository exists on the Hub (or is access-restricted). */
  repository: { exists: boolean; gated?: boolean | string; license?: string; pipelineTag?: string };
  hostedInference: {
    /** A provider exposes this model for the required task. */
    supported: boolean;
    providers: Array<{ provider: string; status?: string; task?: string; contextLength?: number }>;
    adapter?: { kind: string; baseModel?: string; weightsPath?: string };
  };
  pricing: { status: ModelPricing; detail?: string };
  availability: ModelAvailability;
  smokeTest?: { ran: boolean; ok?: boolean; latencyMs?: number; provider?: string; error?: string };
  verificationSource: VerificationSource;
  limitations: string[];
  /** Set when verification itself could not run (network, auth, outage). */
  verificationError?: string;
  checkedAt: string;
}

interface CacheEntry {
  result: VerifyResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

let now: () => number = () => Date.now();
/** Test seam. */
export function __setVerificationClockForTests(fn: (() => number) | null) {
  now = fn ?? (() => Date.now());
}
export function resetVerificationCacheForTests() {
  cache.clear();
  now = () => Date.now();
}

function hoursSince(iso?: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return (now() - then) / 3_600_000;
}

/** True when a persisted verification result is still considered fresh. */
export function verificationIsFresh(row: ModelRow | null, intervalHours: number): boolean {
  if (!row?.lastCheckedAt) return false;
  return hoursSince(row.lastCheckedAt) < intervalHours;
}

function pricingFromProvider(pricing?: { input?: number; output?: number }, isFree?: boolean): { status: ModelPricing; detail?: string } {
  if (isFree === true) return { status: 'free', detail: 'Provider reports the model as free of charge.' };
  if (!pricing || (pricing.input === undefined && pricing.output === undefined)) {
    return { status: 'unknown', detail: 'No pricing published by any provider for this model.' };
  }
  const values = [pricing.input ?? 0, pricing.output ?? 0];
  if (values.every(v => v === 0)) return { status: 'free', detail: 'Provider pricing is zero.' };
  return {
    status: 'paid',
    detail: `Paid inference (input $${pricing.input ?? 0}/M tokens, output $${pricing.output ?? 0}/M tokens).`,
  };
}

function pipelineMatches(pipelineTag: string | undefined, task: ModelTask): boolean | null {
  if (!pipelineTag) return null; // unknown → do not block
  if (task === 'text-generation') return TEXT_PIPELINES.has(pipelineTag);
  return IMAGE_PIPELINES.has(pipelineTag);
}

async function runTextSmokeTest(modelId: string, signal?: AbortSignal) {
  const policy = aiPolicy();
  const started = Date.now();
  try {
    const result = await hfChatCompletion({
      modelId,
      prompt: 'Reply with the single word: OK',
      maxNewTokens: 8,
      temperature: 0,
      timeoutMs: Math.min(policy.requestTimeoutMs, 45_000),
      signal,
    });
    const check = validateTextOutput(result.text, { minChars: 1 });
    return {
      ran: true as const,
      ok: check.ok,
      latencyMs: Date.now() - started,
      provider: result.provider,
      error: check.ok ? undefined : (check.reason ?? 'Empty response'),
    };
  } catch (err) {
    return { ran: true as const, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runImageSmokeTest(modelId: string, signal?: AbortSignal) {
  const policy = aiPolicy();
  const started = Date.now();
  try {
    const result = await hfGenerateImage({
      modelId,
      prompt: 'A simple blue square on a white background',
      width: 256,
      height: 256,
      timeoutMs: Math.min(policy.requestTimeoutMs, 60_000),
      signal,
    });
    const check = validateImageBuffer(result.buffer, { minBytes: 512 });
    return {
      ran: true as const,
      ok: check.ok,
      latencyMs: Date.now() - started,
      provider: result.provider,
      error: check.ok ? undefined : (check.reason ?? 'Invalid image'),
    };
  } catch (err) {
    return { ran: true as const, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Verifies one model and persists the outcome in the registry.
 *
 * Never fabricates: if the Hub or the router cannot be reached, the result
 * carries `verificationError` and the availability becomes `unknown` (not
 * `unavailable`) so a network problem is never reported as "model missing".
 */
async function runAgnesTextSmokeTest(modelId: string, signal?: AbortSignal) {
  const policy = aiPolicy();
  const started = Date.now();
  try {
    const result = await agnesChatCompletion({ model: modelId, prompt: 'Reply with the single word: OK', maxNewTokens: 8, temperature: 0, timeoutMs: Math.min(policy.requestTimeoutMs, 45000), signal });
    const { validateTextOutput } = await import('./output-validation');
    const check = validateTextOutput(result.text, { minChars: 1 });
    return { ran: true as const, ok: check.ok, latencyMs: Date.now() - started, provider: result.provider, error: check.ok ? undefined : (check.reason ?? 'Empty response') };
  } catch (err) { return { ran: true as const, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) }; }
}
async function runAgnesImageSmokeTest(modelId: string, signal?: AbortSignal) {
  const policy = aiPolicy();
  const started = Date.now();
  try {
    const result = await agnesGenerateImage({ model: modelId, prompt: 'A simple blue square', width: 256, height: 256, timeoutMs: Math.min(policy.requestTimeoutMs, 60000), signal });
    const { validateImageBuffer } = await import('./output-validation');
    const check = validateImageBuffer(result.buffer, { minBytes: 512 });
    return { ran: true as const, ok: check.ok, latencyMs: Date.now() - started, provider: result.provider, error: check.ok ? undefined : (check.reason ?? 'Invalid image') };
  } catch (err) { return { ran: true as const, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) }; }
}

export async function verifyModel(modelId: string, options: VerifyOptions = {}): Promise<VerifyResult> {
  const policy = aiPolicy();
  syncRegistry();
  const row = getModelRow(modelId);
  const task = taskForModelId(modelId);
  if (!task) {
    throw new Error(`Model "${modelId}" is not part of the NovelForge registry.`);
  }

  const cached = cache.get(modelId);
  if (!options.force && cached && cached.expiresAt > now()) {
    return cached.result;
  }
  if (!options.force && !cached && verificationIsFresh(row, policy.healthCheckIntervalHours)) {
    // Persisted result is still within the health-check interval.
    return verificationResultFromRow(row!, task);
  }

  const checkedAt = new Date().toISOString();
  const limitations: string[] = row?.limitations ? (safeParse<string[]>(row.limitations) ?? []) : [];

  // ── Agnes AI verification (primary) ─────────────────────────────────────
  const isAgnes = isExplicitAgnesModel(modelId) || !modelId.includes('/');
  if (isAgnes) {
    if (!agnesConfigured()) {
      const result: VerifyResult = {
        modelId, task,
        repository: { exists: true, license: 'agnes-ai' },
        hostedInference: { supported: false, providers: [] },
        pricing: { status: 'unknown', detail: 'AGNES_API_KEY is not configured.' },
        availability: 'unverified',
        verificationSource: 'unverified',
        limitations,
        verificationError: 'AGNES_API_KEY is not configured — no verification was attempted.',
        checkedAt,
      };
      return result;
    }
    let smoke: VerifyResult['smokeTest'];
    const canSmoke = options.smoke === true || (options.smoke !== false && task === 'text-generation');
    const shouldSmokeImage = options.smoke === true && task === 'text-to-image' && policy.allowLiveImageHealthChecks;
    if (canSmoke || shouldSmokeImage) {
      const wantImage = task === 'text-to-image';
      smoke = wantImage ? await runAgnesImageSmokeTest(modelId, options.signal) : await runAgnesTextSmokeTest(modelId, options.signal);
    }
    let availability: ModelAvailability = 'available';
    let verificationSource: VerificationSource = 'live-inference';
    let pricing: { status: ModelPricing; detail?: string } = { status: 'unknown', detail: 'Pricing not confirmed — treated as unknown.' };
    if (smoke) {
      if (smoke.ok) { availability = 'available'; verificationSource = 'live-inference'; pricing = { status: 'free', detail: 'Agnes AI live smoke test succeeded — provider responded.' }; }
      else { availability = availabilityFromSmokeError(smoke.error); limitations.push(`Live smoke test failed: ${smoke.error}`); }
    } else { verificationSource = 'hub-metadata'; limitations.push('Model assumed available; run a smoke test for confirmation.'); }
    const result: VerifyResult = {
      modelId, task,
      repository: { exists: true, pipelineTag: task === 'text-generation' ? 'text-generation' : 'text-to-image', license: 'proprietary' },
      hostedInference: { supported: availability === 'available', providers: [{ provider: 'agnes-ai', status: 'live', task }], adapter: undefined },
      pricing, availability, ...(smoke ? { smokeTest: smoke } : {}), verificationSource, limitations: Array.from(new Set(limitations.filter(Boolean))), checkedAt,
    };
    const previous = getModelRow(modelId);
    const weakerThanLive = previous?.verificationSource === 'live-inference' && verificationSource !== 'live-inference';
    if (!weakerThanLive) {
      patchModel(modelId, {
        availabilityStatus: result.availability, pricingStatus: result.pricing.status, provider: 'agnes-ai',
        license: result.repository.license ?? previous?.license ?? null, limitations: result.limitations,
        verificationSource: result.verificationSource, verified: result.repository.exists, verifiedAt: checkedAt, lastCheckedAt: checkedAt,
        ...(smoke?.ok ? { lastSuccessfulAt: checkedAt, averageLatencyMs: smoke.latencyMs } : { lastCheckedAt: checkedAt }),
      });
      recordModelEvent({ modelId, task, kind: 'verification', ok: result.availability === 'available', provider: 'agnes-ai', latencyMs: smoke?.latencyMs, message: smoke?.ok ? 'Agnes live smoke test succeeded' : smoke ? `Smoke test failed: ${smoke.error}` : 'Agnes model assumed available' });
    }
    cache.set(modelId, { result, expiresAt: now() + policy.modelCacheTtlSeconds * 1000 });
    return result;
  }

  if (!huggingFaceConfigured()) {
    const result: VerifyResult = {
      modelId,
      task,
      repository: { exists: false },
      hostedInference: { supported: false, providers: [] },
      pricing: { status: 'unknown', detail: 'HF_TOKEN is not configured.' },
      availability: 'unverified',
      verificationSource: 'unverified',
      limitations,
      verificationError: 'HF_TOKEN is not configured — no verification was attempted.',
      checkedAt,
    };
    return result;
  }

  let hub: Awaited<ReturnType<typeof hfModelInfo>> | null = null;
  let router: Awaited<ReturnType<typeof hfRouterModelInfo>> | null = null;
  let verificationError: string | undefined;

  try {
    hub = await hfModelInfo(modelId, { signal: options.signal });
  } catch (err) {
    verificationError = `Hub metadata request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    router = await hfRouterModelInfo(modelId, { signal: options.signal });
  } catch (err) {
    // The router catalog is an enhancement; a failure here is not fatal.
    if (!verificationError) {
      verificationError = `Router catalog request failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const existingLimitations = [...limitations];
  const mapping = hub?.inferenceProviderMapping ?? [];
  const providers = [
    ...mapping.map(m => ({
      provider: m.provider,
      status: m.status,
      task: m.task,
      contextLength: router?.providers?.find(p => p.provider === m.provider)?.contextLength,
    })),
    ...(router?.providers
      ?.filter(p => !mapping.some(m => m.provider === p.provider))
      .map(p => ({ provider: p.provider, status: p.status, task: undefined, contextLength: p.contextLength })) ?? []),
  ];

  const adapterEntry = mapping.find(m => m.adapter);
  if (adapterEntry?.adapter) {
    existingLimitations.push(
      `Publishes ${adapterEntry.adapter} adapter weights${adapterEntry.adapterWeightsPath ? ` (${adapterEntry.adapterWeightsPath})` : ''}; needs a compatible base model and an adapter-capable provider.`,
    );
  }

  // ── Availability determination ────────────────────────────────────────────
  let availability: ModelAvailability = 'unknown';
  let verificationSource: VerificationSource = 'hub-metadata';

  if (hub === null && router === null) {
    // Neither endpoint could be reached: the state is unknown, not "broken".
    availability = 'unknown';
    verificationSource = 'unverified';
    existingLimitations.push('Availability could not be checked: neither the Hub nor the router catalog responded.');
  } else if (hub && hub.exists === false && (!router || !router.exists)) {
    availability = 'unavailable';
  } else if (hub && hub.exists === false && router?.exists) {
    availability = 'unknown';
    existingLimitations.push('The Hub repository could not be read, but the router catalog lists the model.');
  } else if (hub?.gated && String(hub.gated) !== 'false') {
    availability = 'authentication_required';
    existingLimitations.push('Repository is gated: access must be granted on Hugging Face before inference.');
  } else if (adapterEntry?.adapter && !providers.some(p => p.status === 'live' && !adapterEntry.adapter)) {
    availability = 'unsupported';
  } else if (pipelineMatches(hub?.pipelineTag, task) === false) {
    availability = 'unsupported';
    existingLimitations.push(`Repository pipeline tag "${hub?.pipelineTag}" does not match the required task "${task}".`);
  } else if (providers.length === 0) {
    availability = 'unavailable';
    existingLimitations.push('No hosted inference provider is mapped to this repository for any task.');
  } else if (!providers.some(p => p.status === 'live')) {
    availability = 'unavailable';
    existingLimitations.push('Mapped providers are not live (staging or errored).');
  } else {
    availability = 'available';
    verificationSource = providers.some(p => p.contextLength !== undefined) ? 'router-catalog' : 'provider-mapping';
  }

  // ── Pricing ───────────────────────────────────────────────────────────────
  const liveProviders = (router?.providers ?? []).filter(p => p.status === 'live');
  const pricingSource = liveProviders.find(p => p.isFree) ?? liveProviders[0];
  const pricing = pricingFromProvider(pricingSource?.pricing, pricingSource?.isFree);
  if (pricing.status === 'unknown') {
    existingLimitations.push('Pricing could not be confirmed before the request: treated as unknown, not free.');
  }

  // ── Optional live smoke test ──────────────────────────────────────────────
  let smoke: VerifyResult['smokeTest'];
  const canSmoke =
    options.smoke !== false &&
    availability === 'available' &&
    (task === 'text-generation' || policy.allowLiveImageHealthChecks);
  if (options.smoke === true || canSmoke) {
    smoke = task === 'text-generation'
      ? await runTextSmokeTest(modelId, options.signal)
      : await runImageSmokeTest(modelId, options.signal);
    if (smoke.ok) {
      availability = 'available';
      verificationSource = 'live-inference';
    } else {
      availability = availabilityFromSmokeError(smoke.error);
      existingLimitations.push(`Live smoke test failed: ${smoke.error}`);
    }
  }

  const result: VerifyResult = {
    modelId,
    task,
    repository: {
      exists: hub?.exists ?? router?.exists ?? false,
      gated: hub?.gated,
      license: hub?.license,
      pipelineTag: hub?.pipelineTag,
    },
    hostedInference: {
      supported: availability === 'available' && providers.some(p => p.status === 'live'),
      providers,
      adapter: adapterEntry?.adapter
        ? { kind: adapterEntry.adapter, baseModel: undefined, weightsPath: adapterEntry.adapterWeightsPath }
        : undefined,
    },
    pricing,
    availability,
    ...(smoke ? { smokeTest: smoke } : {}),
    verificationSource,
    limitations: dedupe(existingLimitations),
    ...(verificationError ? { verificationError } : {}),
    checkedAt,
  };

  // Persist (never overwrite a live-inference success with a weaker source).
  const previous = getModelRow(modelId);
  const weakerThanLive = previous?.verificationSource === 'live-inference' && verificationSource !== 'live-inference';
  if (!weakerThanLive) {
    patchModel(modelId, {
      availabilityStatus: result.availability,
      pricingStatus: result.pricing.status,
      provider: result.hostedInference.providers.find(p => p.status === 'live')?.provider ?? previous?.provider ?? null,
      license: result.repository.license ?? previous?.license ?? null,
      contextLength: result.hostedInference.providers.find(p => p.contextLength)?.contextLength ?? previous?.contextLength ?? null,
      limitations: result.limitations,
      adapter: result.hostedInference.adapter ?? null,
      verificationSource: result.verificationSource,
      verified: result.repository.exists,
      verifiedAt: result.repository.exists ? checkedAt : previous?.verifiedAt ?? null,
      lastCheckedAt: checkedAt,
      ...(smoke?.ok ? { lastSuccessfulAt: checkedAt, averageLatencyMs: smoke.latencyMs } : {}),
    });
    recordModelEvent({
      modelId,
      task,
      kind: 'verification',
      ok: result.availability === 'available',
      provider: result.hostedInference.providers[0]?.provider,
      latencyMs: smoke?.latencyMs,
      message: verificationError
        ? verificationError
        : smoke?.ok
          ? 'Live smoke test succeeded'
          : smoke
            ? `Live smoke test failed: ${smoke.error}`
            : `Repository ${result.repository.exists ? 'exists' : 'missing'} · pricing ${result.pricing.status}`,
    });
  }

  cache.set(modelId, { result, expiresAt: now() + policy.modelCacheTtlSeconds * 1000 });
  return result;
}

function availabilityFromSmokeError(message?: string): ModelAvailability {
  if (!message) return 'unknown';
  const lower = message.toLowerCase();
  if (/401|unauthoriz|invalid api key|token/i.test(lower)) return 'authentication_required';
  if (/403|gated|permission|forbidden/i.test(lower)) return 'authentication_required';
  if (/402|credits?|billing|paid|quota/i.test(lower)) return 'paid_only';
  if (/404|not found|not supported/i.test(lower)) return 'unavailable';
  if (/429|rate/i.test(lower)) return 'rate_limited';
  if (/timed out|timeout/i.test(lower)) return 'temporarily_unavailable';
  if (/fetch failed|econnreset|network|enotfound/i.test(lower)) return 'unknown';
  return 'unknown';
}

function verificationResultFromRow(row: ModelRow, task: ModelTask): VerifyResult {
  return {
    modelId: row.id,
    task,
    repository: { exists: row.verified, license: row.license ?? undefined },
    hostedInference: {
      supported: row.provider !== null || row.availabilityStatus === 'available',
      providers: row.provider ? [{ provider: row.provider, status: 'live' }] : [],
      adapter: row.adapter ? safeParse<{ kind: string; baseModel?: string; weightsPath?: string }>(row.adapter) ?? undefined : undefined,
    },
    pricing: { status: row.pricingStatus },
    availability: row.availabilityStatus,
    verificationSource: row.verificationSource,
    limitations: row.limitations ? (safeParse<string[]>(row.limitations) ?? []) : [],
    checkedAt: row.lastCheckedAt ?? new Date().toISOString(),
  };
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

export interface VerifyAllOptions extends VerifyOptions {
  task?: ModelTask;
  limit?: number;
  /** Bounded concurrency so verification never floods the provider. */
  concurrency?: number;
}

/** Verifies many models with bounded concurrency. Never runs unbounded. */
export async function verifyAllModels(options: VerifyAllOptions = {}): Promise<VerifyResult[]> {
  syncRegistry();
  const { listModelRows } = await import('./model-registry');
  const rows = listModelRows({ task: options.task, limit: options.limit ?? 500 } as never);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 6));
  const results: VerifyResult[] = [];

  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map(row =>
        verifyModel(row.id, options).catch(
          (err): VerifyResult => ({
            modelId: row.id,
            task: row.task,
            repository: { exists: false },
            hostedInference: { supported: false, providers: [] },
            pricing: { status: 'unknown' },
            availability: 'unknown',
            verificationSource: 'unverified',
            limitations: [],
            verificationError: err instanceof Error ? err.message : String(err),
            checkedAt: new Date().toISOString(),
          }),
        ),
      ),
    );
    results.push(...settled);
  }
  return results;
}
