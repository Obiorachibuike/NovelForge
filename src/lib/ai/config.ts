/**
 * Hugging Face + AI policy configuration.
 *
 * Everything here is server-side. The token is read from `process.env` at call
 * time (never at module load) so it is never captured in a module-level
 * constant that could be serialised into a client bundle, and it is excluded
 * from every object this module returns.
 */
import 'server-only';

export type AiBackend = 'huggingface' | 'openai' | 'demo';
export type ImageTransport = 'openai-compatible' | 'task-native' | 'auto';

export interface AiPolicyConfig {
  backend: AiBackend;
  huggingFaceConfigured: boolean;
  routerBaseUrl: string;
  hubApiBaseUrl: string;
  provider: string;
  defaultTextModel: string;
  defaultImageModel: string;
  imageTransport: ImageTransport;
  fallbackEnabled: boolean;
  maxFallbackAttempts: number;
  maxRetriesPerModel: number;
  requestTimeoutMs: number;
  allowPaidInference: boolean;
  requireConfirmedPricing: boolean;
  healthCheckEnabled: boolean;
  healthCheckIntervalHours: number;
  modelCacheTtlSeconds: number;
  maxTextRequestsPerUserPerHour: number;
  maxImageRequestsPerUserPerHour: number;
  maxConcurrentRequests: number;
  allowLiveImageHealthChecks: boolean;
  maxImageEdge: number;
  maxOutputTokens: number;
}

const DEFAULTS = {
  routerBaseUrl: 'https://router.huggingface.co/v1',
  hubApiBaseUrl: 'https://huggingface.co/api',
  provider: 'auto',
  defaultTextModel: 'Qwen/Qwen2.5-7B-Instruct',
  defaultImageModel: 'black-forest-labs/FLUX.1-schnell',
  imageTransport: 'auto' as ImageTransport,
  fallbackEnabled: true,
  maxFallbackAttempts: 4,
  maxRetriesPerModel: 1,
  requestTimeoutMs: 120_000,
  allowPaidInference: false,
  requireConfirmedPricing: true,
  healthCheckEnabled: true,
  healthCheckIntervalHours: 24,
  modelCacheTtlSeconds: 3_600,
  maxTextRequestsPerUserPerHour: 20,
  maxImageRequestsPerUserPerHour: 5,
  maxConcurrentRequests: 2,
  maxImageEdge: 1024,
  maxOutputTokens: 8_000,
};

function envNumber(name: string, fallback: number, min = 0): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.floor(raw));
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

/** A Hugging Face token (fine-grained, "Make calls to Inference Providers"). */
export function huggingFaceToken(): string {
  const raw = process.env.HF_TOKEN || process.env.HUGGINGFACEHUB_API_TOKEN || '';
  const trimmed = raw.trim();
  // Placeholder values from the template must not count as configured.
  if (!trimmed || /^(replace|your|hf_your|xxx)/i.test(trimmed)) return '';
  return trimmed;
}

export function huggingFaceConfigured(): boolean {
  return huggingFaceToken().length > 0;
}

/**
 * Which text backend is active.
 *
 *  - `huggingface` when a HF token is present and the backend is not pinned to
 *    OpenAI (or is explicitly pinned to Hugging Face);
 *  - `openai` when the OpenAI key is used (existing behaviour, unchanged);
 *  - `demo` when no provider credentials exist at all.
 */
export function aiBackend(): AiBackend {
  const pinned = (process.env.AI_BACKEND || process.env.AI_PROVIDER || '').toLowerCase();
  if (pinned === 'huggingface' || pinned === 'hf') {
    return huggingFaceConfigured() ? 'huggingface' : 'demo';
  }
  if (pinned === 'openai') {
    return process.env.OPENAI_API_KEY ? 'openai' : 'demo';
  }
  if (huggingFaceConfigured()) return 'huggingface';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'demo';
}

export function aiPolicy(): AiPolicyConfig {
  const transportRaw = (process.env.AI_IMAGE_TRANSPORT || 'auto').toLowerCase();
  const imageTransport: ImageTransport =
    transportRaw === 'openai-compatible' || transportRaw === 'task-native' ? transportRaw : 'auto';

  return {
    backend: aiBackend(),
    huggingFaceConfigured: huggingFaceConfigured(),
    routerBaseUrl: (process.env.HF_ROUTER_BASE_URL || DEFAULTS.routerBaseUrl).replace(/\/+$/, ''),
    hubApiBaseUrl: (process.env.HF_HUB_API_BASE_URL || DEFAULTS.hubApiBaseUrl).replace(/\/+$/, ''),
    provider: process.env.HF_PROVIDER || DEFAULTS.provider,
    defaultTextModel: process.env.HF_DEFAULT_TEXT_MODEL || DEFAULTS.defaultTextModel,
    defaultImageModel: process.env.HF_DEFAULT_IMAGE_MODEL || DEFAULTS.defaultImageModel,
    imageTransport,
    fallbackEnabled: envBool('AI_FALLBACK_ENABLED', DEFAULTS.fallbackEnabled),
    maxFallbackAttempts: envNumber('AI_MAX_FALLBACK_ATTEMPTS', DEFAULTS.maxFallbackAttempts, 0),
    maxRetriesPerModel: envNumber('AI_MAX_RETRIES_PER_MODEL', DEFAULTS.maxRetriesPerModel, 0),
    requestTimeoutMs: envNumber('AI_REQUEST_TIMEOUT_MS', envNumber('AI_TIMEOUT_MS', DEFAULTS.requestTimeoutMs, 1_000), 1_000),
    allowPaidInference: envBool('AI_ALLOW_PAID_INFERENCE', DEFAULTS.allowPaidInference),
    requireConfirmedPricing: envBool('AI_REQUIRE_CONFIRMED_PRICING', DEFAULTS.requireConfirmedPricing),
    healthCheckEnabled: envBool('AI_MODEL_HEALTH_CHECK_ENABLED', DEFAULTS.healthCheckEnabled),
    healthCheckIntervalHours: envNumber('AI_MODEL_HEALTH_CHECK_INTERVAL_HOURS', DEFAULTS.healthCheckIntervalHours, 1),
    modelCacheTtlSeconds: envNumber('AI_MODEL_CACHE_TTL_SECONDS', DEFAULTS.modelCacheTtlSeconds, 0),
    maxTextRequestsPerUserPerHour: envNumber('AI_MAX_TEXT_REQUESTS_PER_USER_PER_HOUR', DEFAULTS.maxTextRequestsPerUserPerHour, 0),
    maxImageRequestsPerUserPerHour: envNumber('AI_MAX_IMAGE_REQUESTS_PER_USER_PER_HOUR', DEFAULTS.maxImageRequestsPerUserPerHour, 0),
    maxConcurrentRequests: envNumber('AI_MAX_CONCURRENT_REQUESTS', DEFAULTS.maxConcurrentRequests, 1),
    // Expensive: image smoke tests only run when explicitly enabled.
    allowLiveImageHealthChecks: envBool('AI_ALLOW_LIVE_IMAGE_HEALTH_CHECKS', false),
    maxImageEdge: envNumber('AI_MAX_IMAGE_EDGE', DEFAULTS.maxImageEdge, 256),
    maxOutputTokens: envNumber('AI_MAX_COMPLETION_TOKENS', DEFAULTS.maxOutputTokens, 256),
  };
}

/**
 * Validates the AI configuration. Called by the environment validator at
 * startup so a misconfiguration is reported once, clearly, instead of surfacing
 * as a confusing runtime failure on the first generation.
 */
export function validateAiConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const backend = aiBackend();

  const token = (env.HF_TOKEN || '').trim();
  if (token && !/^hf_/.test(token)) {
    problems.push('HF_TOKEN does not look like a Hugging Face user access token (expected to start with "hf_").');
  }
  if (backend === 'huggingface' && !token) {
    problems.push('AI_BACKEND=huggingface but HF_TOKEN is not set.');
  }

  const numericChecks: Array<[string, number, number]> = [
    ['AI_REQUEST_TIMEOUT_MS', envNumber('AI_REQUEST_TIMEOUT_MS', DEFAULTS.requestTimeoutMs, 0), 1_000],
    ['AI_MAX_FALLBACK_ATTEMPTS', envNumber('AI_MAX_FALLBACK_ATTEMPTS', DEFAULTS.maxFallbackAttempts, 0), 0],
    ['AI_MAX_RETRIES_PER_MODEL', envNumber('AI_MAX_RETRIES_PER_MODEL', DEFAULTS.maxRetriesPerModel, 0), 0],
    ['AI_MODEL_HEALTH_CHECK_INTERVAL_HOURS', envNumber('AI_MODEL_HEALTH_CHECK_INTERVAL_HOURS', DEFAULTS.healthCheckIntervalHours, 0), 1],
    ['AI_MODEL_CACHE_TTL_SECONDS', envNumber('AI_MODEL_CACHE_TTL_SECONDS', DEFAULTS.modelCacheTtlSeconds, 0), 0],
  ];
  for (const [name, value, min] of numericChecks) {
    if (value < min) problems.push(`${name} must be >= ${min} (got ${value}).`);
  }

  const router = env.HF_ROUTER_BASE_URL;
  if (router && !/^https:\/\//.test(router)) {
    problems.push('HF_ROUTER_BASE_URL must be an https:// URL.');
  }
  const transport = (env.AI_IMAGE_TRANSPORT || 'auto').toLowerCase();
  if (!['auto', 'openai-compatible', 'task-native'].includes(transport)) {
    problems.push('AI_IMAGE_TRANSPORT must be "auto", "openai-compatible" or "task-native".');
  }
  return problems;
}

/**
 * Free-only policy: whether a model's pricing status makes it eligible.
 *
 * Rules (strict by default):
 *  - paid inference disabled → `paid` models are skipped;
 *  - `unknown` pricing is skipped when confirmed pricing is required, and
 *    allowed (at the operator's risk) only when `AI_REQUIRE_CONFIRMED_PRICING`
 *    is explicitly turned off.
 */
export function pricingAllowed(
  pricingStatus: 'free' | 'paid' | 'unknown',
  policy: Pick<AiPolicyConfig, 'allowPaidInference' | 'requireConfirmedPricing'> = aiPolicy(),
): boolean {
  if (pricingStatus === 'free') return true;
  if (pricingStatus === 'paid') return policy.allowPaidInference;
  return !policy.requireConfirmedPricing;
}
