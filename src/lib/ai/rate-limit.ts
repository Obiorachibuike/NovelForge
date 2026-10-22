/**
 * Per-user rate limits for hosted inference.
 *
 * Independent of the existing per-endpoint limiter: these caps bound how much
 * *provider* traffic one account can generate per hour, which is the control
 * that protects a shared Hugging Face quota (and, when paid inference is
 * enabled, the bill). Database spend limits in `lib/ai/usage.ts` remain the
 * cross-instance control for cost.
 */
import 'server-only';
import { aiPolicy } from './config';
import { HttpError } from '@/lib/api/http';

type AiLimitKind = 'text' | 'image';

const buckets = new Map<string, number[]>();
let now: () => number = () => Date.now();

/** Test seams. */
export function __setAiRateLimitClockForTests(fn: (() => number) | null) {
  now = fn ?? (() => Date.now());
}
export function resetAiRateLimitsForTests() {
  buckets.clear();
  now = () => Date.now();
}

const HOUR = 3_600_000;

function limitFor(kind: AiLimitKind): number {
  const policy = aiPolicy();
  return kind === 'image' ? policy.maxImageRequestsPerUserPerHour : policy.maxTextRequestsPerUserPerHour;
}

export interface AiRateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
  limit: number;
}

export function checkAiRateLimit(kind: AiLimitKind, userId: string): AiRateLimitResult {
  const limit = limitFor(kind);
  if (limit <= 0) return { ok: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterMs: 0, limit: 0 };

  const key = `${kind}:${userId}`;
  const t = now();
  const hits = (buckets.get(key) ?? []).filter(h => t - h < HOUR);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return { ok: false, remaining: 0, retryAfterMs: Math.max(0, HOUR - (t - hits[0])), limit };
  }
  hits.push(t);
  buckets.set(key, hits);
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) {
      const fresh = v.filter(h => t - h < HOUR);
      if (fresh.length) buckets.set(k, fresh);
      else buckets.delete(k);
    }
  }
  return { ok: true, remaining: limit - hits.length, retryAfterMs: 0, limit };
}

/** Throws 429 when the user has exceeded the hourly hosted-inference allowance. */
export function enforceAiRateLimit(kind: AiLimitKind, userId: string): void {
  const result = checkAiRateLimit(kind, userId);
  if (!result.ok) {
    const minutes = Math.max(1, Math.ceil(result.retryAfterMs / 60_000));
    throw new HttpError(
      429,
      `You have reached the ${kind === 'image' ? 'image' : 'text'} generation limit (${result.limit} per hour). Try again in ${minutes} minute(s).`,
      'ai_rate_limited',
    );
  }
}
