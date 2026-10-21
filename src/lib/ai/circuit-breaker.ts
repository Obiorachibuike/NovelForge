/**
 * Per-model circuit breakers.
 *
 * A model that fails repeatedly is skipped for a cooling-off period instead of
 * being retried on every request. This protects latency and provider quota, and
 * it stops a broken model from consuming the whole fallback budget.
 *
 * State is in-memory (per process). It is a *performance* guard, not the source
 * of truth: the authoritative failure record lives in the database model
 * registry, so a restart simply means the breaker re-learns.
 */
export interface CircuitBreakerState {
  failures: number;
  openedAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open, in ms. */
  cooldownMs: number;
}

export const DEFAULT_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 3,
  cooldownMs: 5 * 60_000,
};

const breakers = new Map<string, CircuitBreakerState>();

let now: () => number = () => Date.now();
/** Test seam: deterministic clock for breaker tests. */
export function __setCircuitClockForTests(fn: (() => number) | null) {
  now = fn ?? (() => Date.now());
}
/** Test seam: clears all breaker state. */
export function resetCircuitBreakersForTests() {
  breakers.clear();
  now = () => Date.now();
}

export function circuitState(key: string): CircuitBreakerState {
  return breakers.get(key) ?? { failures: 0 };
}

/**
 * True when the circuit is closed (requests allowed). An open circuit whose
 * cooldown has elapsed moves to half-open: one probe is allowed through.
 */
export function isCircuitClosed(key: string, options: CircuitBreakerOptions = DEFAULT_CIRCUIT_OPTIONS): boolean {
  const state = breakers.get(key);
  if (!state?.openedAt) return true;
  if (now() - state.openedAt >= options.cooldownMs) return true;
  return false;
}

export function recordCircuitSuccess(key: string): void {
  breakers.delete(key);
}

export function recordCircuitFailure(
  key: string,
  reason?: string,
  options: CircuitBreakerOptions = DEFAULT_CIRCUIT_OPTIONS,
): CircuitBreakerState {
  const previous = breakers.get(key) ?? { failures: 0 };
  const failures = previous.failures + 1;
  const shouldOpen = failures >= options.failureThreshold;
  const next: CircuitBreakerState = {
    failures,
    lastFailureAt: now(),
    lastError: reason,
    ...(shouldOpen ? { openedAt: previous.openedAt ?? now() } : {}),
  };
  breakers.set(key, next);
  return next;
}

export function openCircuits(options: CircuitBreakerOptions = DEFAULT_CIRCUIT_OPTIONS): Array<{ key: string; state: CircuitBreakerState }> {
  const out: Array<{ key: string; state: CircuitBreakerState }> = [];
  for (const [key, state] of breakers) {
    if (state.openedAt && now() - state.openedAt < options.cooldownMs) out.push({ key, state });
  }
  return out;
}
