import 'server-only';
import { HttpError } from '@/lib/api/http';

/**
 * In-memory sliding-window rate limiter.
 *
 * This protects a single application instance, which is the deployment shape
 * NovelForge supports today (SQLite + local disk + in-process/worker queue).
 * When several instances share a Redis-backed queue, the same rules should be
 * moved to Redis (or a gateway/WAF); the call sites in the API routes do not
 * need to change. Database-backed spend limits in src/lib/ai/usage.ts are the
 * authoritative cross-instance control for AI cost.
 */
export interface RateLimitRule {
  /** Requests allowed per window, per user. */
  limit: number;
  windowMs: number;
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

const HOUR = 60 * 60 * 1000;

/** Named rule sets used by the API routes. All are overridable by env. */
export const RATE_LIMITS = {
  /** Paid AI text/structured generations (chapter, outline, premise, consistency). */
  aiGeneration: { limit: envInt('RATE_LIMIT_AI_PER_HOUR', 60), windowMs: HOUR },
  /** Interactive editor actions from the writing workspace. */
  aiEditor: { limit: envInt('RATE_LIMIT_EDITOR_PER_HOUR', 240), windowMs: HOUR },
  /** Image generation (the most expensive single request). */
  aiImage: { limit: envInt('RATE_LIMIT_IMAGE_PER_HOUR', 20), windowMs: HOUR },
  /** Export jobs. */
  export: { limit: envInt('RATE_LIMIT_EXPORT_PER_HOUR', 30), windowMs: HOUR },
  /** Account registration bursts per IP. */
  register: { limit: envInt('RATE_LIMIT_REGISTER_PER_HOUR', 10), windowMs: HOUR },
  authRecovery: { limit: envInt('RATE_LIMIT_AUTH_RECOVERY_PER_HOUR', 8), windowMs: HOUR },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

interface Bucket { hits: number[] }
const buckets = new Map<string, Bucket>();
let now: () => number = () => Date.now();

/** Test seam: freezes the clock. */
export function __setClockForTests(fn: (() => number) | null) {
  now = fn ?? (() => Date.now());
}

export function resetRateLimitsForTests() {
  buckets.clear();
  now = () => Date.now();
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

export function checkRateLimit(
  ruleName: RateLimitName,
  subject: string,
  rule: RateLimitRule = RATE_LIMITS[ruleName],
): RateLimitResult {
  const key = `${ruleName}:${subject}`;
  const t = now();
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter(h => t - h < rule.windowMs);
  if (bucket.hits.length >= rule.limit) {
    const oldest = bucket.hits[0];
    buckets.set(key, bucket);
    return { ok: false, remaining: 0, retryAfterMs: Math.max(0, rule.windowMs - (t - oldest)) };
  }
  bucket.hits.push(t);
  buckets.set(key, bucket);
  if (buckets.size > 10_000) sweep(t);
  return { ok: true, remaining: rule.limit - bucket.hits.length, retryAfterMs: 0 };
}

/** Throws a 429 `HttpError` when the subject is over its allowance. */
export function enforceRateLimit(ruleName: RateLimitName, subject: string): void {
  const result = checkRateLimit(ruleName, subject);
  if (!result.ok) {
    throw new HttpError(
      429,
      `Too many requests. Try again in ${Math.ceil(result.retryAfterMs / 1000)}s.`,
      'rate_limited',
    );
  }
}

function sweep(t: number) {
  for (const [key, bucket] of buckets) {
    bucket.hits = bucket.hits.filter(h => t - h < HOUR);
    if (!bucket.hits.length) buckets.delete(key);
  }
}

/** Best-effort client identity for unauthenticated endpoints (registration). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'unknown';
}
