import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { freshDatabase, seedUser, db } from '../helpers/db';
import { __setFetchForTests } from '@/lib/ai/huggingface-client';
import { __setRetrySleepForTests } from '@/lib/ai/retry-policy';
import { resetCircuitBreakersForTests } from '@/lib/ai/circuit-breaker';
import { resetVerificationCacheForTests } from '@/lib/ai/model-verification';
import { patchModel, recordModelSuccess, recentModelEvents, syncRegistry } from '@/lib/ai/model-registry';
import { generateTextHuggingFace, generateStructuredHuggingFace } from '@/lib/ai/hf-text-generation';
import { generateTextDetailed } from '@/lib/ai/text-generation';
import { z } from 'zod';
import {
  chatHandler, chatSuccess, jsonResponse, mockFetch, useHuggingFaceBackend, type MockRouter,
} from './helpers';

let restoreEnv: () => void;
let fetchMock: MockRouter;
let USER_ID = 'user_missing';

/** Marks two text models eligible so selection has a real fallback chain. */
function makeEligible(ids: string[]) {
  syncRegistry();
  for (const id of ids) patchModel(id, { availabilityStatus: 'available', pricingStatus: 'free', provider: 'hf-inference' });
}

beforeEach(() => {
  freshDatabase();
  resetCircuitBreakersForTests();
  resetVerificationCacheForTests();
  restoreEnv = useHuggingFaceBackend();
  __setRetrySleepForTests(async () => {});
  USER_ID = seedUser().id;
});

afterEach(() => {
  __setFetchForTests(null);
  __setRetrySleepForTests(null);
  restoreEnv();
});

describe('Hugging Face text generation', () => {
  it('generates text through the router and records the model actually used', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct']);
    fetchMock = mockFetch([chatHandler(() => chatSuccess('The lantern guttered, and the city held its breath.'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateTextHuggingFace({
      messages: [{ role: 'user', content: 'Write a sentence.' }],
      userId: USER_ID, taskType: 'chapter',
    });

    expect(result.text).toContain('lantern');
    expect(result.model).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(result.requestedModel).toBe('auto');
    expect(result.fallbackUsed).toBe(false);
    expect(result.provider).toBe('hf-inference');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock.callsTo('/chat/completions')).toBe(1);

    // Usage and model health are persisted.
    const usage = db().prepare('SELECT * FROM ai_usage ORDER BY createdAt DESC LIMIT 1').get() as any;
    expect(usage.model).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(usage.actualModel).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(usage.promptTokens).toBe(12);
    expect(usage.costStatus).toBe('estimated');
    const row = db().prepare('SELECT successCount, availabilityStatus FROM ai_model_registry WHERE id = ?').get('Qwen/Qwen2.5-7B-Instruct') as any;
    expect(row.successCount).toBe(1);
    expect(row.availabilityStatus).toBe('available');
  });

  it('sends a chat-completions request with the registered model id and no extra hosts', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct']);
    fetchMock = mockFetch([chatHandler(() => chatSuccess('ok'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    await generateTextHuggingFace({
      messages: [{ role: 'system', content: 'You are a novelist.' }, { role: 'user', content: 'Continue.' }],
      userId: USER_ID, taskType: 'outline', maxTokens: 500,
    });

    const call = fetchMock.calls[0];
    expect(call.url).toBe('https://router.huggingface.co/v1/chat/completions');
    expect(call.body.model).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(call.body.messages[0].role).toBe('system');
    expect(call.body.max_tokens).toBe(500);
  });

  it('classifies an authentication failure without retrying other models', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct']);
    fetchMock = mockFetch([chatHandler(() => jsonResponse({ error: 'Invalid credentials' }, 401))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      generateTextHuggingFace({ messages: [{ role: 'user', content: 'hi' }], userId: 'u', taskType: 'chapter' }),
    ).rejects.toMatchObject({ status: 403, code: 'authentication_failed' });

    // One attempt only: credentials apply to every model.
    expect(fetchMock.callsTo('/chat/completions')).toBe(1);
  });

  it('falls back to another eligible text model when a model is missing', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct']);
    fetchMock = mockFetch([
      chatHandler((body) =>
        body.model === 'Qwen/Qwen2.5-7B-Instruct'
          ? jsonResponse({ error: 'Model not found' }, 404)
          : chatSuccess('Fallback prose arrived.'),
      ),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateTextHuggingFace({
      messages: [{ role: 'user', content: 'Write.' }],
      model: 'Qwen/Qwen2.5-7B-Instruct',
      userId: USER_ID, taskType: 'chapter',
    });

    expect(result.model).toBe('Qwen/Qwen2.5-14B-Instruct');
    expect(result.requestedModel).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(result.fallbackUsed).toBe(true);
    expect(result.text).toContain('Fallback prose');
  });

  it('skips a model whose task is unsupported and records it as unsupported', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct']);
    fetchMock = mockFetch([
      chatHandler((body) =>
        body.model === 'Qwen/Qwen2.5-7B-Instruct'
          ? jsonResponse({ error: 'Model not supported by provider for task' }, 400)
          : chatSuccess('Supported model answered.'),
      ),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateTextHuggingFace({
      messages: [{ role: 'user', content: 'Write.' }],
      model: 'Qwen/Qwen2.5-7B-Instruct',
      userId: USER_ID, taskType: 'chapter',
    });
    expect(result.model).toBe('Qwen/Qwen2.5-14B-Instruct');

    const failed = db().prepare('SELECT availabilityStatus, failureCount FROM ai_model_registry WHERE id = ?').get('Qwen/Qwen2.5-7B-Instruct') as any;
    expect(failed.availabilityStatus).toBe('unsupported');
    expect(failed.failureCount).toBe(1);
  });

  it('retries a rate-limited model and then falls back', async () => {
    process.env.AI_MAX_RETRIES_PER_MODEL = '2';
    makeEligible(['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct']);
    let attemptsOnFirst = 0;
    fetchMock = mockFetch([
      chatHandler((body) => {
        if (body.model !== 'Qwen/Qwen2.5-7B-Instruct') return chatSuccess('Second model worked.');
        attemptsOnFirst++;
        return jsonResponse({ error: 'Rate limit exceeded' }, 429);
      }),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateTextHuggingFace({
      messages: [{ role: 'user', content: 'Write.' }],
      model: 'Qwen/Qwen2.5-7B-Instruct',
      userId: USER_ID, taskType: 'chapter',
    });
    expect(attemptsOnFirst).toBe(3); // initial attempt + 2 retries
    expect(result.model).toBe('Qwen/Qwen2.5-14B-Instruct');
  });

  it('treats a timeout as a transient failure and moves on', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct']);
    fetchMock = mockFetch([
      chatHandler((body) => {
        if (body.model !== 'Qwen/Qwen2.5-7B-Instruct') return chatSuccess('Recovered after timeout.');
        const err = new Error('request timed out after 5000ms');
        err.name = 'TimeoutError';
        throw err;
      }),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateTextHuggingFace({
      messages: [{ role: 'user', content: 'Write.' }],
      model: 'Qwen/Qwen2.5-7B-Instruct',
      userId: USER_ID, taskType: 'chapter',
    });
    expect(result.text).toContain('Recovered');
  });

  it('survives a network error by falling back to another model', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct']);
    fetchMock = mockFetch([
      chatHandler((body) => {
        if (body.model !== 'Qwen/Qwen2.5-7B-Instruct') return chatSuccess('Network-recovered prose.');
        throw new TypeError('fetch failed');
      }),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateTextHuggingFace({
      messages: [{ role: 'user', content: 'Write.' }],
      model: 'Qwen/Qwen2.5-7B-Instruct',
      userId: USER_ID, taskType: 'chapter',
    });
    expect(result.text).toContain('Network-recovered');
  });

  it('rejects empty output instead of saving it', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct']);
    fetchMock = mockFetch([
      chatHandler((body) => (body.model === 'Qwen/Qwen2.5-7B-Instruct' ? chatSuccess('   ') : chatSuccess('Valid prose here.'))),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateTextHuggingFace({
      messages: [{ role: 'user', content: 'Write.' }],
      model: 'Qwen/Qwen2.5-7B-Instruct',
      userId: USER_ID, taskType: 'chapter',
    });
    expect(result.text).toBe('Valid prose here.');
    expect(result.trail[0].category).toBe('empty_output');
  });

  it('rejects malformed structured output and uses a model that returns valid JSON', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct']);
    const schema = z.object({ logline: z.string(), themes: z.array(z.string()).default([]) });
    fetchMock = mockFetch([
      chatHandler((body) =>
        body.model === 'Qwen/Qwen2.5-7B-Instruct'
          ? chatSuccess('not json at all')
          : chatSuccess(JSON.stringify({ logline: 'A heir returns.', themes: ['duty'] })),
      ),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const { data, meta } = await generateStructuredHuggingFace({
      schema,
      messages: [{ role: 'user', content: 'Give me a premise.' }],
      model: 'Qwen/Qwen2.5-7B-Instruct',
      userId: USER_ID, taskType: 'premise',
    });
    expect(data.logline).toBe('A heir returns.');
    expect(meta.model).toBe('Qwen/Qwen2.5-14B-Instruct');
  });

  it('validates structured output against the schema and rejects wrong shapes', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct']);
    const schema = z.object({ chapters: z.array(z.object({ chapterNumber: z.number(), title: z.string() })).min(1) });
    fetchMock = mockFetch([chatHandler(() => chatSuccess(JSON.stringify({ chapters: 'not-an-array' })))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      generateStructuredHuggingFace({
        schema,
        messages: [{ role: 'user', content: 'Outline.' }],
        model: 'Qwen/Qwen2.5-7B-Instruct',
        userId: USER_ID, taskType: 'outline',
        allowFallback: false,
      }),
    ).rejects.toMatchObject({ code: 'malformed_output' });
  });

  it('fails clearly when every eligible model fails (no fabricated output)', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct']);
    fetchMock = mockFetch([chatHandler(() => jsonResponse({ error: 'Internal provider error' }, 500))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      generateTextHuggingFace({
        messages: [{ role: 'user', content: 'Write.' }],
        userId: USER_ID, taskType: 'chapter',
      }),
    ).rejects.toMatchObject({ status: 503, code: 'provider_outage' });
  });

  it('routes the existing text service through Hugging Face and reports provenance', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct']);
    fetchMock = mockFetch([chatHandler(() => chatSuccess('Chapter text from hosted inference.'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);
    const user = seedUser();

    const result = await generateTextDetailed({
      messages: [{ role: 'user', content: 'Write chapter 1.' }],
      userId: user.id, taskType: 'chapter', allowFallbackOnError: false,
    });

    expect(result.meta.source).toBe('huggingface');
    expect(result.meta.model).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(result.meta.usedFallback).toBe(false);
    expect(result.text).toContain('hosted inference');
  });

  it('never substitutes stub prose for a real failure when fallback is disabled', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct']);
    fetchMock = mockFetch([chatHandler(() => jsonResponse({ error: 'boom' }, 500))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      generateTextDetailed({
        messages: [{ role: 'user', content: 'Write.' }],
        userId: USER_ID, taskType: 'chapter', allowFallbackOnError: false,
      }),
    ).rejects.toThrow();
  });

  it('remembers a successful model for later selection', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct']);
    fetchMock = mockFetch([chatHandler(() => chatSuccess('ok'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);
    recordModelSuccess('Qwen/Qwen2.5-7B-Instruct', { provider: 'together', latencyMs: 400, task: 'text-generation' });

    const row = db().prepare('SELECT * FROM ai_model_registry WHERE id = ?').get('Qwen/Qwen2.5-7B-Instruct') as any;
    expect(row.provider).toBe('together');
    expect(row.verificationSource).toBe('live-inference');
    expect(row.lastSuccessfulAt).toBeTruthy();
  });
});

describe('pricing policy', () => {
  it('skips paid models when paid inference is disabled', async () => {
    syncRegistry();
    process.env.AI_REQUIRE_CONFIRMED_PRICING = 'true';
    process.env.AI_ALLOW_PAID_INFERENCE = 'false';
    patchModel('Qwen/Qwen2.5-7B-Instruct', { availabilityStatus: 'available', pricingStatus: 'paid', provider: 'together' });
    fetchMock = mockFetch([chatHandler(() => chatSuccess('should not be used'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      generateTextHuggingFace({ messages: [{ role: 'user', content: 'Write.' }], userId: 'u', taskType: 'chapter' }),
    ).rejects.toMatchObject({ code: 'no_eligible_model' });
    expect(fetchMock.calls.length).toBe(0);
  });

  it('skips models with unknown pricing when confirmed pricing is required', async () => {
    syncRegistry();
    process.env.AI_REQUIRE_CONFIRMED_PRICING = 'true';
    fetchMock = mockFetch([chatHandler(() => chatSuccess('should not be used'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const err: any = await generateTextHuggingFace({
      messages: [{ role: 'user', content: 'Write.' }], userId: USER_ID, taskType: 'chapter',
    }).catch(e => e);
    expect(err.code).toBe('no_eligible_model');
    expect(err.message).toMatch(/No eligible hosted model/i);
    expect(err.message).toMatch(/pricing/i);
    expect(fetchMock.calls.length).toBe(0);
  });

  it('allows a paid model once paid inference is explicitly enabled', async () => {
    syncRegistry();
    process.env.AI_ALLOW_PAID_INFERENCE = 'true';
    patchModel('Qwen/Qwen2.5-7B-Instruct', { availabilityStatus: 'available', pricingStatus: 'paid', provider: 'together' });
    fetchMock = mockFetch([chatHandler(() => chatSuccess('paid model output'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateTextHuggingFace({
      messages: [{ role: 'user', content: 'Write.' }],
      model: 'Qwen/Qwen2.5-7B-Instruct', userId: USER_ID, taskType: 'chapter', allowFallback: false,
    });
    expect(result.text).toBe('paid model output');
  });

  it('blocks a 402 response as paid-only and skips the model', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct']);
    fetchMock = mockFetch([
      chatHandler((body) =>
        body.model === 'Qwen/Qwen2.5-7B-Instruct'
          ? jsonResponse({ error: 'Payment required: insufficient credits' }, 402)
          : chatSuccess('Free model output.'),
      ),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateTextHuggingFace({
      messages: [{ role: 'user', content: 'Write.' }],
      model: 'Qwen/Qwen2.5-7B-Instruct', userId: USER_ID, taskType: 'chapter',
    });
    expect(result.text).toBe('Free model output.');
    const events = recentModelEvents({ onlyFailures: true, modelId: 'Qwen/Qwen2.5-7B-Instruct' });
    expect(events[0].category).toBe('paid_inference_required');
    expect(events[0].message).toMatch(/paid inference/i);
  });
});
