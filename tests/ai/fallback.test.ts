import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { freshDatabase, seedUser } from '../helpers/db';
import { __setFetchForTests } from '@/lib/ai/huggingface-client';
import { __setRetrySleepForTests, backoffDelayMs, runWithRetries } from '@/lib/ai/retry-policy';
import {
  circuitState, isCircuitClosed, recordCircuitFailure, resetCircuitBreakersForTests, __setCircuitClockForTests,
} from '@/lib/ai/circuit-breaker';
import { checkAiRateLimit, enforceAiRateLimit, resetAiRateLimitsForTests, __setAiRateLimitClockForTests } from '@/lib/ai/rate-limit';
import { patchModel, recordModelFailure, recordModelSuccess, setModelEnabled, setPrimaryModel, syncRegistry } from '@/lib/ai/model-registry';
import { selectModels, assertRegisteredModel, explainNoEligibleModel } from '@/lib/ai/model-selection';
import { orchestrateGeneration } from '@/lib/ai/fallback-orchestrator';
import { HttpError } from '@/lib/api/http';
import { classifyAiError } from '@/lib/ai/error-classifier';
import {
  chatHandler, chatSuccess, chatViaInjected, jsonResponse, mockFetch, useHuggingFaceBackend, type MockRouter,
} from './helpers';

let restoreEnv: () => void;
let fetchMock: MockRouter;
let USER_ID = 'user_missing';

beforeEach(() => {
  freshDatabase();
  resetCircuitBreakersForTests();
  resetAiRateLimitsForTests();
  restoreEnv = useHuggingFaceBackend();
  __setRetrySleepForTests(async () => {});
  USER_ID = seedUser().id;
  syncRegistry();
});

afterEach(() => {
  __setFetchForTests(null);
  __setRetrySleepForTests(null);
  resetCircuitBreakersForTests();
  resetAiRateLimitsForTests();
  restoreEnv();
});

describe('model selection', () => {
  it('prefers the requested model, then availability, then observed success', () => {
    patchModel('Qwen/Qwen2.5-7B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    patchModel('Qwen/Qwen2.5-14B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    patchModel('Qwen/Qwen2.5-32B-Instruct', { availabilityStatus: 'unverified', pricingStatus: 'unknown' });
    // Real evidence, recorded the same way a live generation records it.
    for (let i = 0; i < 5; i++) {
      recordModelSuccess('Qwen/Qwen2.5-7B-Instruct', { provider: 'together', latencyMs: 900, task: 'text-generation' });
    }
    recordModelSuccess('Qwen/Qwen2.5-14B-Instruct', { provider: 'together', latencyMs: 900, task: 'text-generation' });
    for (let i = 0; i < 3; i++) {
      recordModelFailure('Qwen/Qwen2.5-14B-Instruct', { category: 'rate_limited', availability: 'rate_limited', message: 'Rate limited', task: 'text-generation' });
    }

    const result = selectModels({ task: 'text-generation', limit: 50 });
    expect(result.candidates[0].model.id).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(result.candidates.map(c => c.model.id)).toContain('Qwen/Qwen2.5-32B-Instruct');
  });

  it('puts an explicitly requested model first but keeps a fallback chain behind it', () => {
    for (const id of ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct', 'Qwen/Qwen2.5-32B-Instruct']) {
      patchModel(id, { availabilityStatus: 'available', pricingStatus: 'free' });
    }
    const result = selectModels({ task: 'text-generation', modelId: 'Qwen/Qwen2.5-32B-Instruct', allowFallback: true });
    expect(result.candidates[0].model.id).toBe('Qwen/Qwen2.5-32B-Instruct');
    expect(result.candidates.length).toBeGreaterThan(1);

    const pinned = selectModels({ task: 'text-generation', modelId: 'Qwen/Qwen2.5-32B-Instruct', allowFallback: false });
    expect(pinned.candidates.length).toBe(1);
  });

  it('gives the administrator-assigned primary model a scoring bonus', () => {
    for (const id of ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct']) {
      patchModel(id, { availabilityStatus: 'available', pricingStatus: 'free' });
    }
    const before = selectModels({ task: 'text-generation', limit: 50 });
    const scoreBefore = before.candidates.find(c => c.model.id === 'Qwen/Qwen2.5-72B-Instruct')!.score;
    setPrimaryModel('text-generation', 'Qwen/Qwen2.5-72B-Instruct');
    const after = selectModels({ task: 'text-generation', limit: 50 });
    const entry = after.candidates.find(c => c.model.id === 'Qwen/Qwen2.5-72B-Instruct')!;
    // Primacy is a scoring bonus, not a hard pin: other models stay eligible.
    expect(entry.score).toBeGreaterThan(scoreBefore);
    expect(entry.reasons.join(' ')).toMatch(/primary/i);
    expect(after.candidates.length).toBe(before.candidates.length);
  });

  it('skips disabled, unsupported, gated and paid-only models with reasons', () => {
    setModelEnabled('Qwen/Qwen2.5-7B-Instruct', false, 'Too slow');
    patchModel('Qwen/Qwen2.5-14B-Instruct', { availabilityStatus: 'unsupported' });
    patchModel('Qwen/Qwen2.5-32B-Instruct', { availabilityStatus: 'authentication_required' });
    patchModel('Qwen/Qwen2.5-72B-Instruct', { availabilityStatus: 'paid_only', pricingStatus: 'paid' });

    const result = selectModels({ task: 'text-generation' });
    const skipped = new Map(result.skipped.map(s => [s.modelId, s.reason]));
    expect(skipped.get('Qwen/Qwen2.5-7B-Instruct')).toMatch(/Too slow/);
    expect(skipped.get('Qwen/Qwen2.5-14B-Instruct')).toMatch(/unsupported/i);
    expect(skipped.get('Qwen/Qwen2.5-32B-Instruct')).toMatch(/gated|access/i);
    expect(skipped.get('Qwen/Qwen2.5-72B-Instruct')).toMatch(/paid/i);
    expect(result.candidates.some(c => c.model.id === 'Qwen/Qwen2.5-72B-Instruct')).toBe(false);
  });

  it('filters out models whose context window is too small for the request', () => {
    patchModel('microsoft/Phi-3-mini-4k-instruct', { availabilityStatus: 'available', pricingStatus: 'free', contextLength: 4096 });
    const result = selectModels({ task: 'text-generation', requiredContextTokens: 24_000 });
    const skipped = result.skipped.find(s => s.modelId === 'microsoft/Phi-3-mini-4k-instruct');
    expect(skipped?.reason).toMatch(/context/i);
    expect(result.candidates.some(c => c.model.id === 'microsoft/Phi-3-mini-4k-instruct')).toBe(false);
  });

  it('only ever considers text models for text and image models for image', () => {
    patchModel('Qwen/Qwen2.5-7B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    patchModel('black-forest-labs/FLUX.1-schnell', { availabilityStatus: 'available', pricingStatus: 'free' });

    const text = selectModels({ task: 'text-generation' });
    const image = selectModels({ task: 'text-to-image' });
    for (const candidate of text.candidates) expect(candidate.model.task).toBe('text-generation');
    for (const candidate of image.candidates) expect(candidate.model.task).toBe('text-to-image');
  });

  it('explains an empty chain instead of silently picking something', () => {
    process.env.AI_REQUIRE_CONFIRMED_PRICING = 'true';
    const result = selectModels({ task: 'text-generation' });
    expect(result.candidates).toHaveLength(0);
    expect(explainNoEligibleModel(result)).toMatch(/pricing|eligible/i);
  });

  it('rejects model ids that are not in the registry', () => {
    expect(() => assertRegisteredModel('Qwen/Qwen2.5-7B-Instruct', 'text-generation')).not.toThrow();
    expect(() => assertRegisteredModel('hacker/sneaky-model', 'text-generation')).toThrow(HttpError);
    assertRegisteredModel('black-forest-labs/FLUX.1-schnell', 'text-to-image');
    // A text model is not a valid image model.
    expect(() => assertRegisteredModel('Qwen/Qwen2.5-7B-Instruct', 'text-to-image')).toThrow(HttpError);
  });
});

describe('fallback orchestration', () => {
  it('is bounded: it never tries more models than the configured budget', async () => {
    process.env.AI_MAX_FALLBACK_ATTEMPTS = '3';
    for (const id of ['Qwen/Qwen2.5-0.5B-Instruct', 'Qwen/Qwen2.5-1.5B-Instruct', 'Qwen/Qwen2.5-3B-Instruct', 'Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct']) {
      patchModel(id, { availabilityStatus: 'available', pricingStatus: 'free' });
    }
    let calls = 0;
    fetchMock = mockFetch([chatHandler(() => { calls++; return jsonResponse({ error: 'Service overloaded' }, 503); })]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      orchestrateGeneration<string>({
        task: 'text-generation',
        run: model => chatViaInjected(model.id),
        validate: () => ({ ok: true }),
        context: { userId: USER_ID, taskType: 'chapter' },
      }),
    ).rejects.toMatchObject({ status: 503 });

    expect(calls).toBeLessThanOrEqual(3);
  });

  it('stops the chain on an authentication failure instead of trying every model', async () => {
    for (const id of ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct', 'Qwen/Qwen2.5-32B-Instruct']) {
      patchModel(id, { availabilityStatus: 'available', pricingStatus: 'free' });
    }
    let calls = 0;
    fetchMock = mockFetch([chatHandler(() => { calls++; return jsonResponse({ error: 'Invalid credentials' }, 401); })]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const err: any = await orchestrateGeneration<string>({
      task: 'text-generation',
      run: model => chatViaInjected(model.id),
      validate: () => ({ ok: true }),
    }).catch(e => e);
    expect(err.code).toBe('authentication_failed');
    expect(calls).toBe(1);
  });

  it('records the requested and the actual model for provenance', async () => {
    patchModel('Qwen/Qwen2.5-7B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    patchModel('Qwen/Qwen2.5-14B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    fetchMock = mockFetch([
      chatHandler(body => (body.model === 'Qwen/Qwen2.5-7B-Instruct' ? jsonResponse({ error: 'Model not found' }, 404) : chatSuccess('Fallback text.', {}, 'together'))),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await orchestrateGeneration<string>({
      task: 'text-generation',
      requestedModelId: 'Qwen/Qwen2.5-7B-Instruct',
      run: model => chatViaInjected(model.id),
      validate: value => ({ ok: value.length > 0 }),
    });

    expect(result.requestedModelId).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(result.actualModelId).toBe('Qwen/Qwen2.5-14B-Instruct');
    expect(result.fallbackUsed).toBe(true);
    expect(result.attemptTrail.map(a => a.modelId)).toEqual(['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct']);
  });

  it('does not fall back when the caller disables it', async () => {
    patchModel('Qwen/Qwen2.5-7B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    patchModel('Qwen/Qwen2.5-14B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    fetchMock = mockFetch([chatHandler(() => jsonResponse({ error: 'Model not found' }, 404))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const err: any = await orchestrateGeneration<string>({
      task: 'text-generation',
      requestedModelId: 'Qwen/Qwen2.5-7B-Instruct',
      allowFallback: false,
      run: model => chatViaInjected(model.id),
      validate: () => ({ ok: true }),
    }).catch(e => e);
    expect(err.code).toBe('model_not_found');
    expect(fetchMock.callsTo('/chat/completions')).toBe(1);
  });

  it('never mixes tasks: an image request is only ever offered image models', async () => {
    patchModel('Qwen/Qwen2.5-7B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    const seen: string[] = [];
    const err: any = await orchestrateGeneration<string>({
      task: 'text-to-image',
      run: async model => { seen.push(model.id); throw Object.assign(new Error('nope'), { status: 503 }); },
      validate: () => ({ ok: true }),
    }).catch(e => e);
    expect(err.status).toBe(503);
    expect(seen.length).toBeGreaterThan(0);
    for (const id of seen) expect(id).not.toBe('Qwen/Qwen2.5-7B-Instruct');
  });
});

describe('reliability primitives', () => {
  it('applies exponential backoff with a cap', () => {
    expect(backoffDelayMs(1)).toBeLessThanOrEqual(4_000);
    expect(backoffDelayMs(10)).toBeLessThanOrEqual(4_000);
    expect(backoffDelayMs(3)).toBeGreaterThanOrEqual(backoffDelayMs(1));
  });

  it('retries transient errors and gives up on permanent ones', async () => {
    let attempts = 0;
    const ok = await runWithRetries(
      async () => {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
        return 'done';
      },
      err => classifyAiError(err),
      { policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } },
    );
    expect(ok.ok).toBe(true);
    expect(ok.value).toBe('done');
    expect(attempts).toBe(3);

    let authAttempts = 0;
    const failed = await runWithRetries(
      async () => {
        authAttempts++;
        throw Object.assign(new Error('Invalid credentials'), { status: 401 });
      },
      err => classifyAiError(err),
      { policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } },
    );
    expect(failed.ok).toBe(false);
    expect(authAttempts).toBe(1);
    expect(failed.error?.category).toBe('authentication_failed');
  });

  it('opens a circuit after repeated failures and closes it again after the cooldown', () => {
    let clock = 1_000;
    __setCircuitClockForTests(() => clock);
    for (let i = 0; i < 3; i++) recordCircuitFailure('Qwen/Qwen2.5-7B-Instruct', 'boom');
    expect(isCircuitClosed('Qwen/Qwen2.5-7B-Instruct')).toBe(false);
    expect(circuitState('Qwen/Qwen2.5-7B-Instruct').failures).toBe(3);
    expect(circuitState('Qwen/Qwen2.5-7B-Instruct').openedAt).toBe(1_000);
    clock += 10 * 60_000; // past the cooldown: half-open allows one probe
    expect(isCircuitClosed('Qwen/Qwen2.5-7B-Instruct')).toBe(true);
    __setCircuitClockForTests(null);
  });

  it('penalises a tripped model in selection and skips it in the orchestrator', async () => {
    patchModel('Qwen/Qwen2.5-7B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    patchModel('Qwen/Qwen2.5-14B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    __setCircuitClockForTests(() => 2_000);
    for (let i = 0; i < 4; i++) recordCircuitFailure('Qwen/Qwen2.5-7B-Instruct', 'boom');

    const result = selectModels({ task: 'text-generation' });
    const tripped = result.candidates.find(c => c.model.id === 'Qwen/Qwen2.5-7B-Instruct');
    const healthy = result.candidates.find(c => c.model.id === 'Qwen/Qwen2.5-14B-Instruct');
    expect(tripped!.score).toBeLessThan(healthy!.score);
    expect(tripped!.reasons.join(' ')).toMatch(/circuit/i);

    // The orchestrator refuses to spend an attempt on a tripped model.
    const attempted: string[] = [];
    fetchMock = mockFetch([chatHandler(() => chatSuccess('Prose from a healthy model.'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);
    const out = await orchestrateGeneration<string>({
      task: 'text-generation',
      requestedModelId: 'Qwen/Qwen2.5-7B-Instruct',
      run: model => { attempted.push(model.id); return chatViaInjected(model.id); },
      validate: value => ({ ok: value.length > 0 }),
    });
    expect(attempted).not.toContain('Qwen/Qwen2.5-7B-Instruct');
    expect(out.actualModelId).not.toBe('Qwen/Qwen2.5-7B-Instruct');
    __setCircuitClockForTests(null);
  });

  it('enforces per-user request budgets', () => {
    process.env.AI_MAX_TEXT_REQUESTS_PER_USER_PER_HOUR = '2';
    resetAiRateLimitsForTests();
    enforceAiRateLimit('text', USER_ID);
    enforceAiRateLimit('text', USER_ID);
    const third = checkAiRateLimit('text', USER_ID);
    expect(third.ok).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
    expect(third.remaining).toBe(0);
    expect(() => enforceAiRateLimit('text', USER_ID)).toThrow(HttpError);
    // A different user has their own budget.
    expect(checkAiRateLimit('text', 'someone_else').ok).toBe(true);
  });

  it('rate limits image requests separately from text requests', () => {
    process.env.AI_MAX_IMAGE_REQUESTS_PER_USER_PER_HOUR = '1';
    resetAiRateLimitsForTests();
    enforceAiRateLimit('image', USER_ID);
    expect(checkAiRateLimit('image', USER_ID).ok).toBe(false);
    expect(checkAiRateLimit('text', USER_ID).ok).toBe(true);
  });

  it('honours the injected test clock', () => {
    let now = 1_000;
    process.env.AI_MAX_TEXT_REQUESTS_PER_USER_PER_HOUR = '1';
    resetAiRateLimitsForTests();
    __setAiRateLimitClockForTests(() => now);
    enforceAiRateLimit('text', USER_ID);
    expect(checkAiRateLimit('text', USER_ID).ok).toBe(false);
    now += 3_600_000 * 2;
    expect(checkAiRateLimit('text', USER_ID).ok).toBe(true);
    __setAiRateLimitClockForTests(null);
  });
});
