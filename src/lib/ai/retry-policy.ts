/**
 * Bounded retry policy with exponential backoff, jitter and `Retry-After`
 * support. Retries are always bounded: there is no code path that loops
 * indefinitely, and a permanent failure aborts after the first attempt.
 */
import { isRetryable } from './error-classifier';
import type { AiErrorInfo } from './types';

export interface RetryPolicy {
  /** Total attempts per model, including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 2, baseDelayMs: 400, maxDelayMs: 4_000 };

let _sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms));
let _jitter: () => number = () => Math.random();

/** Test seams: remove real waiting from the test suite. */
export function __setRetrySleepForTests(fn: ((ms: number) => Promise<void>) | null) {
  _sleep = fn ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
}
export function __setRetryJitterForTests(fn: (() => number) | null) {
  _jitter = fn ?? (() => Math.random());
}

/** Exponential backoff with full-jitter, capped, honouring `Retry-After`. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY, retryAfterMs?: number): number {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(retryAfterMs, 60_000);
  }
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.5 + _jitter() * 0.5));
}

export interface AttemptOutcome<T> {
  ok: boolean;
  value?: T;
  error?: AiErrorInfo;
  /** Raw thrown value from the last attempt (kept server-side). */
  rawError?: unknown;
  attempts: number;
  delaysMs: number[];
}

/**
 * Runs `fn` up to `policy.maxAttempts` times while the classified error is
 * retryable. Permanent errors, cancellation (via `signal`) and exhausted
 * attempts all return a failed outcome rather than throwing.
 */
export async function runWithRetries<T>(
  fn: (attempt: number) => Promise<T>,
  classify: (err: unknown) => AiErrorInfo,
  options: { policy?: RetryPolicy; signal?: AbortSignal; onRetry?: (info: AiErrorInfo, attempt: number) => void } = {},
): Promise<AttemptOutcome<T>> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const maxAttempts = Math.max(1, Math.min(policy.maxAttempts, 6));
  const delays: number[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      return { ok: false, attempts: attempt - 1, delaysMs: delays, error: classify(new Error('Generation request was cancelled.')) };
    }
    try {
      const value = await fn(attempt);
      return { ok: true, value, attempts: attempt, delaysMs: delays };
    } catch (err) {
      const info = classify(err);
      if (attempt >= maxAttempts || !info.retryable || !isRetryable(info.category) || options.signal?.aborted) {
        return { ok: false, error: info, rawError: err, attempts: attempt, delaysMs: delays };
      }
      const delay = backoffDelayMs(attempt, policy, info.retryAfterMs);
      delays.push(delay);
      options.onRetry?.(info, attempt);
      await _sleep(delay);
    }
  }
  return { ok: false, attempts: maxAttempts, delaysMs: delays, error: classify(new Error('Retry loop exhausted.')) };
}

/** Runs a promise with a hard timeout, rejecting with a timeout-shaped error. */
export async function withDeadline<T>(promise: Promise<T>, ms: number, label = 'AI request'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} timed out after ${ms}ms`);
          err.name = 'TimeoutError';
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
