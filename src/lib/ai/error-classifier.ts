/**
 * Error classification for hosted inference.
 *
 * Provider failures arrive in many shapes: HTTP statuses, OpenAI-style error
 * bodies, Hugging Face router errors, network exceptions, and "successful"
 * responses that contain nothing usable. Everything is normalised into an
 * `AiErrorInfo` that drives retry, fallback, model health and the user-facing
 * message. Raw provider text is never surfaced verbatim: it can contain
 * tokens, URLs and account identifiers.
 */
import type { AiErrorCategory, AiErrorInfo, ModelAvailability } from './types';

export const ERROR_CATEGORY_AVAILABILITY: Partial<Record<AiErrorCategory, ModelAvailability>> = {
  authentication_failed: 'authentication_required',
  permission_denied: 'authentication_required',
  gated_model: 'authentication_required',
  model_not_found: 'unavailable',
  unsupported_task: 'unsupported',
  provider_unsupported: 'unsupported',
  rate_limited: 'rate_limited',
  quota_exceeded: 'temporarily_unavailable',
  timeout: 'temporarily_unavailable',
  network_error: 'unknown',
  provider_outage: 'temporarily_unavailable',
  invalid_request: 'unknown',
  content_policy: 'unavailable',
  empty_output: 'unknown',
  malformed_output: 'unknown',
  invalid_image: 'unknown',
  paid_inference_required: 'paid_only',
  configuration_error: 'unknown',
  unknown: 'unknown',
};

/** Categories that must never be retried against the same model. */
const PERMANENT: AiErrorCategory[] = [
  'authentication_failed',
  'permission_denied',
  'gated_model',
  'model_not_found',
  'unsupported_task',
  'provider_unsupported',
  'invalid_request',
  'content_policy',
  'paid_inference_required',
  'configuration_error',
];

/** Categories where another model of the same task is worth trying. */
const FALLBACKABLE: AiErrorCategory[] = [
  'model_not_found',
  'unsupported_task',
  'provider_unsupported',
  'gated_model',
  'permission_denied',
  'rate_limited',
  'quota_exceeded',
  'timeout',
  'network_error',
  'provider_outage',
  'empty_output',
  'malformed_output',
  'invalid_image',
  'paid_inference_required',
  'unknown',
];

interface ProviderErrorLike {
  status?: number;
  code?: string;
  message?: string;
  error?: unknown;
  name?: string;
  cause?: unknown;
  headers?: { get(name: string): string | null };
  retryAfterMs?: number;
}

function textOf(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const anyErr = err as ProviderErrorLike;
  if (typeof anyErr.message === 'string') return anyErr.message;
  if (anyErr.error && typeof anyErr.error === 'object') {
    const inner = anyErr.error as { message?: string; error?: string; type?: string };
    return [inner.type, inner.message, inner.error].filter(Boolean).join(' ');
  }
  if (anyErr.error && typeof anyErr.error === 'string') return anyErr.error;
  return '';
}

function statusOf(err: unknown): number | undefined {
  const anyErr = err as ProviderErrorLike;
  if (typeof anyErr?.status === 'number') return anyErr.status;
  const status = (anyErr as any)?.response?.status ?? (anyErr as any)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/** Reads `Retry-After` (seconds or HTTP date) from a provider error if present. */
export function retryAfterFromHeaders(err: unknown): number | undefined {
  const headers = (err as ProviderErrorLike)?.headers;
  if (!headers || typeof headers.get !== 'function') return undefined;
  const raw = headers.get('retry-after') || headers.get('Retry-After');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

function isAbort(err: unknown): boolean {
  const anyErr = err as { name?: string; code?: string | number };
  return anyErr?.name === 'AbortError' || anyErr?.name === 'TimeoutError' || anyErr?.code === 20 || anyErr?.code === 'ABORT_ERR' || anyErr?.code === 'ETIMEDOUT';
}

/**
 * Classifies any thrown value (or an HTTP response) into an `AiErrorInfo`.
 *
 * `context.modelId` is only used for message wording — never for credentials.
 */
export function classifyAiError(err: unknown, context: { modelId?: string; task?: string } = {}): AiErrorInfo {
  const message = textOf(err);
  const lower = message.toLowerCase();
  const status = statusOf(err);
  const modelLabel = context.modelId ? ` (${context.modelId})` : '';
  const retryAfterMs = retryAfterFromHeaders(err) ?? (err as ProviderErrorLike)?.retryAfterMs;

  // The client can state the category outright (e.g. an HTTP 200 that carried
  // no image bytes). Trust it over the status code.
  const forced = (err as { category?: AiErrorCategory })?.category;
  if (forced) {
    const defaults: Partial<Record<AiErrorCategory, { retryable: boolean; availability: ModelAvailability }>> = {
      invalid_image: { retryable: true, availability: 'unknown' },
      malformed_output: { retryable: true, availability: 'unknown' },
      empty_output: { retryable: true, availability: 'unknown' },
      content_policy: { retryable: false, availability: 'unavailable' },
    };
    const fallback = defaults[forced] ?? { retryable: true, availability: 'unknown' as ModelAvailability };
    return make(forced, message || 'The inference request failed.', fallback.retryable, true, fallback.availability, status, retryAfterMs);
  }

  if (isAbort(err)) {
    return make('timeout', `The request to ${context.modelId || 'the model'} timed out.`, true, true, undefined, status, retryAfterMs);
  }

  // ── HTTP status based classification ──────────────────────────────────────
  if (status === 401) {
    return make('authentication_failed', 'Hugging Face rejected the credentials. Check HF_TOKEN and its Inference Providers permission.', false, false, 'authentication_required', status);
  }
  if (status === 402) {
    return make('paid_inference_required', 'This model requires paid inference credits, which are disabled by the current pricing policy.', false, true, 'paid_only', status);
  }
  if (status === 403) {
    if (/gated|access|permission|not authorize|terms|accepted/i.test(lower)) {
      return make('gated_model', `Access to ${context.modelId || 'this model'} is gated or not granted to this account.`, false, true, 'authentication_required', status);
    }
    return make('permission_denied', `This account is not permitted to use ${context.modelId || 'this model'}.`, false, true, 'authentication_required', status);
  }
  if (status === 404) {
    return make('model_not_found', `The model ${context.modelId || ''} was not found or is not served by any configured provider.`.replace('  ', ' '), false, true, 'unavailable', status);
  }
  if (status === 408 || status === 504) {
    return make('timeout', 'The inference provider timed out.', true, true, 'temporarily_unavailable', status, retryAfterMs);
  }
  if (status === 409) {
    return make('provider_outage', 'The provider reported a conflict or overloaded state.', true, true, 'temporarily_unavailable', status, retryAfterMs);
  }
  if (status === 422) {
    if (/paid|billing|credits?|quota/i.test(lower)) {
      return make('paid_inference_required', 'The provider requires paid credits for this request.', false, true, 'paid_only', status);
    }
    return make('invalid_request', `The provider rejected the request parameters for ${context.modelId || 'the model'}.`, false, true, 'unknown', status);
  }
  if (status === 429) {
    const quota = /quota|credits?|insufficient|billing/i.test(lower);
    return make(
      quota ? 'quota_exceeded' : 'rate_limited',
      quota ? 'The account has run out of inference credits or quota.' : 'The provider is rate limiting requests right now.',
      true,
      true,
      quota ? 'temporarily_unavailable' : 'rate_limited',
      status,
      retryAfterMs,
    );
  }
  if (status && status >= 500) {
    return make('provider_outage', 'The inference provider is temporarily unavailable.', true, true, 'temporarily_unavailable', status, retryAfterMs);
  }
  if (status === 400) {
    if (/not supported|unsupported|does not support|task/i.test(lower)) {
      return make('unsupported_task', `${context.modelId || 'This model'} does not support this task through hosted inference.`, false, true, 'unsupported', status);
    }
    if (/model|provider/i.test(lower) && /not (found|supported)|unknown/i.test(lower)) {
      return make('provider_unsupported', 'No configured provider serves this model for the requested task.', false, true, 'unsupported', status);
    }
    if (/paid|billing|credits?/i.test(lower)) {
      return make('paid_inference_required', 'The provider requires paid credits for this request.', false, true, 'paid_only', status);
    }
    return make('invalid_request', `The provider rejected the request for ${context.modelId || 'the model'}.`, false, true, 'unknown', status);
  }

  // ── Message based classification (network, timeouts, policies) ────────────
  if (/fetch failed|econnreset|enotfound|eai_again|socket hang up|network|dns/i.test(lower)) {
    return make('network_error', 'Could not reach the inference provider. Check outbound network access.', true, true, 'unknown', status);
  }
  if (/timed out|timeout|deadline/i.test(lower)) {
    return make('timeout', 'The inference request timed out.', true, true, 'temporarily_unavailable', status, retryAfterMs);
  }
  if (/invalid api key|unauthoriz|forbidden|authentication|token/i.test(lower) && /hf_|token|key|auth/i.test(lower)) {
    return make('authentication_failed', 'Hugging Face rejected the credentials.', false, false, 'authentication_required', status);
  }
  if (/gated|must accept|agree to the terms|request access/i.test(lower)) {
    return make('gated_model', `Access to ${context.modelId || 'this model'} must be granted on Hugging Face first.`, false, true, 'authentication_required', status);
  }
  if (/content polic|nsfw|safety|moderation|flagged/i.test(lower)) {
    return make('content_policy', 'The provider refused this prompt for content-policy reasons.', false, false, 'unavailable', status);
  }
  if (/credits?|billing|payment required|insufficient funds|quota exceeded/i.test(lower)) {
    return make('paid_inference_required', 'This request requires paid inference credits, which are disabled by the current pricing policy.', false, true, 'paid_only', status);
  }
  if (/empty|no (?:text|content|choices)|returned nothing/i.test(lower)) {
    return make('empty_output', `The model returned no usable ${context.task === 'text-to-image' ? 'image' : 'text'}${modelLabel}.`, true, true, 'unknown', status);
  }
  if (/json|schema|parse|malformed|invalid (?:image|response)/i.test(lower)) {
    return make('malformed_output', 'The model returned output that could not be validated.', true, true, 'unknown', status);
  }

  return make('unknown', `The inference request failed${modelLabel}.`, true, true, 'unknown', status, retryAfterMs);
}

function make(
  category: AiErrorCategory,
  userMessage: string,
  retryable: boolean,
  fallbackable: boolean,
  availability: ModelAvailability | undefined,
  status?: number,
  retryAfterMs?: number,
): AiErrorInfo {
  return {
    category,
    userMessage,
    retryable: retryable && !PERMANENT.includes(category),
    fallbackable: fallbackable && FALLBACKABLE.includes(category),
    availability: availability ?? ERROR_CATEGORY_AVAILABILITY[category],
    status,
    retryAfterMs,
  };
}

/** Convenience: is this category worth retrying on the same model? */
export function isRetryable(category: AiErrorCategory): boolean {
  return !PERMANENT.includes(category) && category !== 'content_policy';
}
