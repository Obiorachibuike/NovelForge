/**
 * Real-provider generation path fixes.
 *
 *  - a fresh deployment can select unverified/unknown-pricing models instead of
 *    dead-ending on "No eligible hosted model" (the strict policy remains
 *    available via AI_REQUIRE_CONFIRMED_PRICING=true);
 *  - a successful live inference promotes `pricingStatus` from `unknown`;
 *  - AI_DEMO_MODE=true suppresses every paid call even with a key configured;
 *  - a model whose provider credential is missing produces a precise
 *    configuration error instead of silently substituting demo prose;
 *  - Agnes response parsing tolerates real-world content/usage shapes;
 *  - queued chapter jobs serialise their payload chapter number so the queue
 *    and the writing workspace can match them before the chapter row exists.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { freshDatabase, seedUser, seedNovel, seedOutline, db } from '../helpers/db';
import { __setFetchForTests as setAgnesFetch } from '@/lib/ai/agnes-client';
import { __setFetchForTests as setHfFetch } from '@/lib/ai/huggingface-client';
import { selectModels } from '@/lib/ai/model-selection';
import { patchModel, recordModelSuccess, syncRegistry, getModelRow } from '@/lib/ai/model-registry';
import { generateTextDetailed, hostedBackendActive } from '@/lib/ai/text-generation';
import { agnesChatCompletion } from '@/lib/ai/agnes-client';
import { enqueue, registerHandler } from '@/lib/queue';
import { serializeGeneration, getGenerationForUser } from '@/lib/jobs/generation-jobs';
import {
  agnesChatSuccess,
  agnesHandler,
  jsonResponse,
  mockFetch,
  useAgnesBackend,
  type MockRouter,
} from './helpers';

let restoreEnv: (() => void) | undefined;
let fetchMock: MockRouter;
const ENV = { ...process.env };

beforeEach(() => {
  freshDatabase();
  restoreEnv?.();
  process.env = { ...ENV };
  delete process.env.AI_DEMO_MODE;
  delete process.env.AI_REQUIRE_CONFIRMED_PRICING;
});

afterEach(() => {
  setAgnesFetch(null);
  setHfFetch(null);
  restoreEnv?.();
  restoreEnv = undefined;
  process.env = { ...ENV };
});

describe('model eligibility is not a bootstrapping dead-end', () => {
  it('selects unverified models with unknown pricing under the default policy', () => {
    syncRegistry();
    // No AI_REQUIRE_CONFIRMED_PRICING override: the deployment default applies.
    const result = selectModels({ task: 'text-generation' });
    expect(result.candidates.length).toBeGreaterThan(0);
    // Honesty is preserved: the evidence-less models are still labelled unverified.
    expect(result.candidates[0].model.availabilityStatus).toBe('unverified');
    expect(result.candidates[0].model.pricingStatus).toBe('unknown');
  });

  it('still skips unknown pricing when the strict policy is requested explicitly', () => {
    syncRegistry();
    process.env.AI_REQUIRE_CONFIRMED_PRICING = 'true';
    const result = selectModels({ task: 'text-generation' });
    expect(result.candidates).toHaveLength(0);
  });

  it('a successful live inference promotes pricing from unknown to confirmed free', () => {
    syncRegistry();
    const id = 'Qwen/Qwen2.5-7B-Instruct';
    expect(getModelRow(id)?.pricingStatus).toBe('unknown');
    recordModelSuccess(id, { provider: 'together', latencyMs: 300, task: 'text-generation' });
    const row = getModelRow(id);
    expect(row?.pricingStatus).toBe('free');
    expect(row?.availabilityStatus).toBe('available');

    // A recorded `paid` model is never downgraded by success.
    patchModel('Qwen/Qwen2.5-14B-Instruct', { pricingStatus: 'paid', availabilityStatus: 'available' });
    recordModelSuccess('Qwen/Qwen2.5-14B-Instruct', { provider: 'together', latencyMs: 300, task: 'text-generation' });
    expect(getModelRow('Qwen/Qwen2.5-14B-Instruct')?.pricingStatus).toBe('paid');
  });
});

describe('AI_DEMO_MODE=true suppresses paid calls even with a key configured', () => {
  it('returns labelled demo text and performs zero provider requests', async () => {
    restoreEnv = useAgnesBackend({ fallback: false });
    process.env.AI_DEMO_MODE = 'true';
    fetchMock = mockFetch([agnesHandler(() => agnesChatSuccess('should never be requested'))]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    expect(hostedBackendActive()).toBe(false);

    const result = await generateTextDetailed({
      messages: [{ role: 'user', content: 'Write a sentence.' }],
      userId: 'u',
      taskType: 'chapter',
    });
    expect(result.meta.source).toBe('demo');
    expect(fetchMock.calls).toHaveLength(0);
  });
});

describe('missing provider credentials produce a precise error, never demo prose', () => {
  it('an explicit Hugging Face model without HF_TOKEN fails with provider_not_configured', async () => {
    restoreEnv = useAgnesBackend({ fallback: false }); // AGNES_API_KEY set, no HF_TOKEN
    fetchMock = mockFetch([agnesHandler(() => agnesChatSuccess('should never be requested'))]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const err: any = await generateTextDetailed({
      messages: [{ role: 'user', content: 'Write.' }],
      model: 'Qwen/Qwen2.5-7B-Instruct',
      userId: 'u',
      taskType: 'chapter',
      allowFallbackOnError: false,
    }).catch(e => e);

    expect(err?.code).toBe('provider_not_configured');
    expect(String(err?.message)).toContain('HF_TOKEN');
    expect(String(err?.message)).toContain('Qwen/Qwen2.5-7B-Instruct');
    expect(fetchMock.calls).toHaveLength(0);
  });

  it('tolerant callers still get a labelled fallback instead of a throw', async () => {
    restoreEnv = useAgnesBackend({ fallback: false });
    const result = await generateTextDetailed({
      messages: [{ role: 'user', content: 'Write.' }],
      model: 'Qwen/Qwen2.5-7B-Instruct',
      userId: 'u',
      taskType: 'chapter',
      allowFallbackOnError: true,
    });
    expect(result.meta.source).toBe('fallback');
    expect(result.meta.usedFallback).toBe(true);
  });
});

describe('Agnes response parsing tolerates real provider shapes', () => {
  it('accepts message.content as an array of content parts', async () => {
    restoreEnv = useAgnesBackend({ fallback: false });
    fetchMock = mockFetch([
      agnesHandler(() =>
        jsonResponse({
          model: 'agnes-2.5-flash',
          choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: 'Assembled ' }, { type: 'text', text: 'from parts.' }] } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    ]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const result = await agnesChatCompletion({ prompt: 'Write.' });
    expect(result.text).toBe('Assembled from parts.');
    // Usage aliases (input_tokens/output_tokens) are normalised too.
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('surfaces a 200-with-error payload as a failure, not empty output', async () => {
    restoreEnv = useAgnesBackend({ fallback: false });
    fetchMock = mockFetch([
      agnesHandler(() => jsonResponse({ error: { message: 'upstream exploded' } })),
    ]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const err: any = await agnesChatCompletion({ prompt: 'Write.' }).catch(e => e);
    expect(err?.status).toBe(502);
    expect(String(err?.message)).toContain('upstream exploded');
  });
});

describe('queued chapter jobs serialise their chapter number', () => {
  it('falls back to the payload chapter number before the chapter row exists', async () => {
    const user = seedUser();
    const novel = seedNovel(user.id);
    seedOutline(novel.id, 1);
    registerHandler('chapter', async () => ({ ok: true }));
    // A queued chapter job for chapter 3: no chapter row yet.
    const id = await enqueue({
      type: 'chapter', userId: user.id, novelId: novel.id, chapterId: null, payload: { chapterNumber: 3 },
    });
    const job = getGenerationForUser(user.id, id)!;
    const serialized = serializeGeneration(job);
    expect(serialized.chapterNumber).toBe(3);
  });
});
