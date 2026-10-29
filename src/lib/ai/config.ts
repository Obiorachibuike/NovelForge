/**
 * Hugging Face + AI policy configuration.
 *
 * Everything here is server-side. The token is read from `process.env` at call
 * time (never at module load) so it is never captured in a module-level
 * constant that could be serialised into a client bundle, and it is excluded
 * from every object this module returns.
 */
import 'server-only';

export type AiBackend = 'agnes' | 'huggingface' | 'openai' | 'demo';
export type ImageTransport = 'openai-compatible' | 'task-native' | 'auto';

export interface AiPolicyConfig {
  backend: AiBackend;
  /** Agnes AI (apihub.agnes-ai.com) is the primary text/image provider. */
  agnesConfigured: boolean;
  agnesBaseUrl: string;
  agnesTextModel: string;
  agnesImageModel: string;
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
  agnesBaseUrl: 'https://apihub.agnes-ai.com/v1',
  agnesTextModel: 'agnes-2.5-flash',
  agnesImageModel: 'agnes-image-2.5-flash',
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
 * An Agnes AI API key (created in the Agnes AI console at
 * platform.agnes-ai.com). Agnes AI is the primary text and image provider;
 * Hugging Face hosted inference is the fallback.
 */
export function agnesToken(): string {
  const raw = process.env.AGNES_API_KEY || '';
  const trimmed = raw.trim();
  // Placeholder values from the template must not count as configured.
  if (!trimmed || /^(replace|your|agnes_your|xxx|sk-your)/i.test(trimmed)) return '';
  return trimmed;
}

export function agnesConfigured(): boolean {
  return agnesToken().length > 0;
}

/** True when the requested model id explicitly names an Agnes AI model. */
export function isExplicitAgnesModel(model?: string | null): boolean {
  return !!model && /^agnes([-.].*)?$/i.test(model.trim());
}

/** True when the requested model id explicitly names a Hugging Face repo. */
export function isExplicitHuggingFaceModel(model?: string | null): boolean {
  return !!model && model.includes('/');
}

/**
 * Which text backend is active.
 *
 *  - `agnes`        when an AGNES_API_KEY is present (unless pinned otherwise):
 *                   Agnes AI serves text and images, Hugging Face falls back;
 *  - `huggingface`  when a HF token is present and the backend is not pinned to
 *                   OpenAI (or is explicitly pinned to Hugging Face);
 *  - `openai`       when the OpenAI key is used (existing behaviour, unchanged);
 *  - `demo`         when no provider credentials exist at all.
 */
export function aiBackend(): AiBackend {
  const pinned = (process.env.AI_BACKEND || process.env.AI_PROVIDER || '').toLowerCase();
  if (pinned === 'agnes') {
    return agnesConfigured() ? 'agnes' : 'demo';
  }
  if (pinned === 'huggingface' || pinned === 'hf') {
    return huggingFaceConfigured() ? 'huggingface' : 'demo';
  }
  if (pinned === 'openai') {
    return process.env.OPENAI_API_KEY ? 'openai' : 'demo';
  }
  if (agnesConfigured()) return 'agnes';
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
    agnesConfigured: agnesConfigured(),
    agnesBaseUrl: (process.env.AGNES_BASE_URL || DEFAULTS.agnesBaseUrl).replace(/\/+$/, ''),
    agnesTextModel: process.env.AGNES_TEXT_MODEL || DEFAULTS.agnesTextModel,
    agnesImageModel: process.env.AGNES_IMAGE_MODEL || DEFAULTS.agnesImageModel,
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

// ─────────────────────────────────────────────────────────────────────────────
// Provider status (secret-free)
// ─────────────────────────────────────────────────────────────────────────────

export interface AiProviderStatus {
  name: 'agnes' | 'huggingface' | 'openai';
  /** Where the provider sits in the chain: primary, fallback or legacy backend. */
  role: 'primary' | 'fallback' | 'legacy';
  /** Whether the credential this provider needs is present in this runtime. */
  configured: boolean;
  /** Model ids the provider will be asked for (not secrets). */
  models?: { text?: string; image?: string };
  endpoint?: string;
}

export interface AiProviderSummary {
  /** The backend the next generation request will actually use. */
  backend: AiBackend;
  /** Backends in the order they are attempted when fallback is enabled. */
  providerOrder: Array<'agnes' | 'huggingface' | 'openai'>;
  /** `AI_BACKEND` when an operator pinned one explicitly. */
  pinnedBackend: 'agnes' | 'huggingface' | 'openai' | null;
  providers: AiProviderStatus[];
  /** Configuration problems by variable *name* only — never a value. */
  problems: string[];
}

/**
 * Describes which hosted-inference provider is live and which credentials are
 * present, without ever reading a secret back out.
 *
 * This exists because "I set the API key in the host" and "the running
 * deployment is calling that provider" are different facts: a deployment made
 * before the variable was added, or a variable scoped to the wrong environment,
 * still reports a working demo backend. `backend` is the honest answer for the
 * process answering the request.
 */
export function aiProviderSummary(): AiProviderSummary {
  const pinnedRaw = (process.env.AI_BACKEND || process.env.AI_PROVIDER || '').toLowerCase();
  const pinnedBackend =
    pinnedRaw === 'agnes' || pinnedRaw === 'openai'
      ? pinnedRaw
      : pinnedRaw === 'huggingface' || pinnedRaw === 'hf'
        ? 'huggingface'
        : null;

  const policy = aiPolicy();
  const providers: AiProviderStatus[] = [
    {
      name: 'agnes',
      role: 'primary',
      configured: policy.agnesConfigured,
      models: { text: policy.agnesTextModel, image: policy.agnesImageModel },
      endpoint: policy.agnesBaseUrl,
    },
    {
      name: 'huggingface',
      role: 'fallback',
      configured: policy.huggingFaceConfigured,
      models: { text: policy.defaultTextModel, image: policy.defaultImageModel },
      endpoint: policy.routerBaseUrl,
    },
    {
      name: 'openai',
      role: 'legacy',
      configured: Boolean((process.env.OPENAI_API_KEY || '').trim()),
      models: {
        text: process.env.AI_TEXT_MODEL || 'gpt-4o-mini',
        image: process.env.AI_IMAGE_MODEL || 'dall-e-3',
      },
      // Whether an OpenAI fallback is reached depends on the backend policy.
      endpoint: 'https://api.openai.com/v1',
    },
  ];

  return {
    backend: policy.backend,
    providerOrder: ['agnes', 'huggingface', 'openai'],
    pinnedBackend,
    providers,
    problems: validateAiConfig(process.env),
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

  const agnesKey = (env.AGNES_API_KEY || '').trim();
  const pinnedBackend = (env.AI_BACKEND || env.AI_PROVIDER || '').toLowerCase();
  if (pinnedBackend === 'agnes' && !agnesKey) {
    problems.push('AI_BACKEND=agnes but AGNES_API_KEY is not set.');
  }
  const agnesBase = env.AGNES_BASE_URL;
  if (agnesBase && !/^https:\/\//.test(agnesBase)) {
    problems.push('AGNES_BASE_URL must be an https:// URL.');
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
