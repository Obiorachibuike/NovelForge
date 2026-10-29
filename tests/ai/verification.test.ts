import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { freshDatabase, db } from '../helpers/db';
import { __setFetchForTests } from '@/lib/ai/huggingface-client';
import { resetVerificationCacheForTests, verifyAllModels, verifyModel } from '@/lib/ai/model-verification';
import { getModelRow, recentModelEvents, registryOverview, syncRegistry } from '@/lib/ai/model-registry';
import { chatHandler, chatSuccess, hubMetadata, jsonResponse, mockFetch, routerModel, useHuggingFaceBackend, type MockRouter } from './helpers';

let restoreEnv: () => void;
let fetchMock: MockRouter;

const HUB_URL = 'https://huggingface.co/api/models/';
const ROUTER_URL = 'https://router.huggingface.co/v1/models/';

/** Splits fake traffic between the Hub metadata API, the router catalog and inference. */
function fakeHub(handlers: {
  hub?: (url: string) => Response | null;
  router?: (url: string) => Response | null;
  chat?: (body: any) => Response | null;
}): MockRouter {
  return mockFetch([
    (url) => (url.startsWith(HUB_URL) && handlers.hub ? handlers.hub(url.slice(HUB_URL.length)) : null),
    (url) => (url.startsWith(ROUTER_URL) && handlers.router ? handlers.router(url.slice(ROUTER_URL.length)) : null),
    chatHandler(body => (handlers.chat ? handlers.chat(body) : null)),
  ]);
}

beforeEach(() => {
  freshDatabase();
  resetVerificationCacheForTests();
  restoreEnv = useHuggingFaceBackend();
  syncRegistry();
});

afterEach(() => {
  __setFetchForTests(null);
  resetVerificationCacheForTests();
  restoreEnv();
});

describe('model verification', () => {
  it('reports an available, free model when the Hub and router agree', async () => {
    fetchMock = fakeHub({
      hub: () => hubMetadata({
        id: 'Qwen/Qwen2.5-7B-Instruct',
        pipeline_tag: 'text-generation',
        gated: false,
        license: 'apache-2.0',
        inferenceProviderMapping: [{ provider: 'together', status: 'live', task: 'text-generation' }],
      }),
      router: () => routerModel({
        id: 'Qwen/Qwen2.5-7B-Instruct',
        providers: [{ provider: 'together', status: 'live', isFree: true, pricing: { input: 0, output: 0 }, contextLength: 32_768 }],
      }),
    });
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await verifyModel('Qwen/Qwen2.5-7B-Instruct', { smoke: false, force: true });

    expect(result.availability).toBe('available');
    expect(result.pricing.status).toBe('free');
    expect(result.hostedInference.supported).toBe(true);
    expect(result.repository.exists).toBe(true);
    expect(result.verificationSource).toBe('router-catalog');
    expect(result.verificationError).toBeUndefined();

    const row = getModelRow('Qwen/Qwen2.5-7B-Instruct');
    expect(row?.availabilityStatus).toBe('available');
    expect(row?.pricingStatus).toBe('free');
    expect(row?.provider).toBe('together');
    expect(row?.license).toBe('apache-2.0');
    expect(row?.contextLength).toBe(32_768);
  });

  it('reports a paid model as paid (never as free)', async () => {
    fetchMock = fakeHub({
      hub: () => hubMetadata({
        id: 'deepseek-ai/DeepSeek-V3',
        pipeline_tag: 'text-generation',
        inferenceProviderMapping: [{ provider: 'together', status: 'live', task: 'text-generation' }],
      }),
      router: () => routerModel({
        id: 'deepseek-ai/DeepSeek-V3',
        providers: [{ provider: 'together', status: 'live', isFree: false, pricing: { input: 1.25, output: 1.25 } }],
      }),
    });
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await verifyModel('deepseek-ai/DeepSeek-V3', { smoke: false, force: true });
    expect(result.availability).toBe('available');
    expect(result.pricing.status).toBe('paid');
    expect(result.pricing.detail).toMatch(/1\.25/);
    expect(getModelRow('deepseek-ai/DeepSeek-V3')?.pricingStatus).toBe('paid');
  });

  it('reports unknown pricing when no provider publishes it', async () => {
    fetchMock = fakeHub({
      hub: () => hubMetadata({
        id: 'jialinyyzz/humanizer',
        pipeline_tag: 'text-generation',
        inferenceProviderMapping: [{ provider: 'hf-inference', status: 'live', task: 'text-generation' }],
      }),
      router: () => routerModel({ id: 'jialinyyzz/humanizer', providers: [{ provider: 'hf-inference', status: 'live' }] }),
    });
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await verifyModel('jialinyyzz/humanizer', { smoke: false, force: true });
    expect(result.availability).toBe('available');
    expect(result.pricing.status).toBe('unknown');
    expect(result.limitations.join(' ')).toMatch(/unknown, not free/i);
  });

  it('marks a gated repository as access-required instead of broken', async () => {
    fetchMock = fakeHub({
      hub: () => hubMetadata({
        id: 'meta-llama/Llama-3.1-70B-Instruct',
        pipeline_tag: 'text-generation',
        gated: true,
        inferenceProviderMapping: [{ provider: 'together', status: 'live', task: 'text-generation' }],
      }),
      router: () => routerModel({ id: 'meta-llama/Llama-3.1-70B-Instruct', providers: [{ provider: 'together', status: 'live' }] }),
    });
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await verifyModel('meta-llama/Llama-3.1-70B-Instruct', { smoke: false, force: true });
    expect(result.availability).toBe('authentication_required');
    expect(result.repository.gated).toBeTruthy();
    expect(result.limitations.join(' ')).toMatch(/gated/i);
  });

  it('reports a missing repository as unavailable', async () => {
    fetchMock = fakeHub({
      hub: () => jsonResponse({ error: 'Not Found' }, 404),
      router: () => jsonResponse({ error: 'Not Found' }, 404),
    });
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await verifyModel('ConwayResearch/Underdog-Saluki-27B-1.0', { smoke: false, force: true });
    expect(result.availability).toBe('unavailable');
    expect(result.repository.exists).toBe(false);
    expect(getModelRow('ConwayResearch/Underdog-Saluki-27B-1.0')?.availabilityStatus).toBe('unavailable');
  });

  it('reports a model with no live provider as unavailable', async () => {
    fetchMock = fakeHub({
      hub: () => hubMetadata({
        id: 'databricks/dbrx-instruct',
        pipeline_tag: 'text-generation',
        inferenceProviderMapping: [{ provider: 'together', status: 'staging', task: 'text-generation' }],
      }),
      router: () => routerModel({ id: 'databricks/dbrx-instruct', providers: [{ provider: 'together', status: 'staging' }] }),
    });
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await verifyModel('databricks/dbrx-instruct', { smoke: false, force: true });
    expect(result.availability).toBe('unavailable');
    expect(result.limitations.join(' ')).toMatch(/not live/i);
  });

  it('flags a pipeline/task mismatch as unsupported', async () => {
    fetchMock = fakeHub({
      hub: () => hubMetadata({
        id: 'sentence-transformers/all-MiniLM-L6-v2',
        pipeline_tag: 'sentence-similarity',
        inferenceProviderMapping: [{ provider: 'hf-inference', status: 'live', task: 'sentence-similarity' }],
      }),
      router: () => routerModel({ id: 'x', providers: [{ provider: 'hf-inference', status: 'live' }] }),
    });
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await verifyModel('Qwen/Qwen2.5-7B-Instruct', { smoke: false, force: true });
    expect(result.availability).toBe('unsupported');
    expect(result.limitations.join(' ')).toMatch(/pipeline tag/i);
  });

  it('records LoRA adapter metadata instead of pretending the weights are a model', async () => {
    fetchMock = fakeHub({
      hub: () => hubMetadata({
        id: 'XLabs-AI/flux-RealismLora',
        pipeline_tag: 'text-to-image',
        inferenceProviderMapping: [
          { provider: 'fal-ai', status: 'live', task: 'text-to-image', adapter: 'lora', adapterWeightsPath: 'flux-RealismLora.safetensors' },
        ],
      }),
      router: () => routerModel({ id: 'XLabs-AI/flux-RealismLora', providers: [{ provider: 'fal-ai', status: 'live' }] }),
    });
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await verifyModel('XLabs-AI/flux-RealismLora', { smoke: false, force: true });
    expect(result.availability).toBe('unsupported');
    expect(result.hostedInference.adapter?.kind).toBe('lora');
    expect(result.hostedInference.adapter?.weightsPath).toBe('flux-RealismLora.safetensors');
    expect(result.limitations.join(' ')).toMatch(/adapter weights/i);
    const row = getModelRow('XLabs-AI/flux-RealismLora');
    expect(JSON.parse(row!.adapter!)).toMatchObject({ kind: 'lora' });
  });

  it('treats a network failure as unknown, never as "the model does not exist"', async () => {
    fetchMock = mockFetch([
      () => { throw new TypeError('fetch failed'); },
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await verifyModel('Qwen/Qwen2.5-7B-Instruct', { smoke: false, force: true });
    expect(result.verificationError).toMatch(/Hub metadata request failed/);
    expect(result.availability).toBe('unknown');
    expect(result.pricing.status).toBe('unknown');
    const row = getModelRow('Qwen/Qwen2.5-7B-Instruct');
    expect(row?.availabilityStatus).toBe('unknown');
  });

  it('never downgrades a live-inference success to a weaker verification source', async () => {
    // First pass: a real smoke test succeeds.
    fetchMock = fakeHub({
      hub: () => hubMetadata({
        id: 'Qwen/Qwen2.5-7B-Instruct',
        pipeline_tag: 'text-generation',
        inferenceProviderMapping: [{ provider: 'together', status: 'live', task: 'text-generation' }],
      }),
      router: () => routerModel({ id: 'Qwen/Qwen2.5-7B-Instruct', providers: [{ provider: 'together', status: 'live', isFree: true }] }),
      chat: () => chatSuccess('OK', {}, 'together'),
    });
    __setFetchForTests(fetchMock as unknown as typeof fetch);
    const first = await verifyModel('Qwen/Qwen2.5-7B-Instruct', { smoke: true, force: true });
    expect(first.smokeTest?.ok).toBe(true);
    expect(first.verificationSource).toBe('live-inference');

    // Second pass: the Hub is unreachable, but the earlier live success stands.
    __setFetchForTests(mockFetch([() => { throw new TypeError('fetch failed'); }]) as unknown as typeof fetch);
    resetVerificationCacheForTests();
    await verifyModel('Qwen/Qwen2.5-7B-Instruct', { smoke: false, force: true });
    const row = getModelRow('Qwen/Qwen2.5-7B-Instruct');
    expect(row?.verificationSource).toBe('live-inference');
    expect(row?.availabilityStatus).toBe('available');
  });

  it('keeps a failing smoke test out of the "available" bucket', async () => {
    fetchMock = fakeHub({
      hub: () => hubMetadata({
        id: 'Qwen/Qwen2.5-7B-Instruct',
        pipeline_tag: 'text-generation',
        inferenceProviderMapping: [{ provider: 'together', status: 'live', task: 'text-generation' }],
      }),
      router: () => routerModel({ id: 'Qwen/Qwen2.5-7B-Instruct', providers: [{ provider: 'together', status: 'live' }] }),
      chat: () => jsonResponse({ error: 'Payment required' }, 402),
    });
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await verifyModel('Qwen/Qwen2.5-7B-Instruct', { smoke: true, force: true });
    expect(result.smokeTest?.ran).toBe(true);
    expect(result.smokeTest?.ok).toBe(false);
    expect(result.availability).toBe('paid_only');
    expect(result.limitations.join(' ')).toMatch(/smoke test failed/i);
  });

  it('does not run image smoke tests unless they are explicitly enabled', async () => {
    fetchMock = fakeHub({
      hub: () => hubMetadata({
        id: 'black-forest-labs/FLUX.1-schnell',
        pipeline_tag: 'text-to-image',
        inferenceProviderMapping: [{ provider: 'fal-ai', status: 'live', task: 'text-to-image' }],
      }),
      router: () => routerModel({ id: 'black-forest-labs/FLUX.1-schnell', providers: [{ provider: 'fal-ai', status: 'live', isFree: true }] }),
    });
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await verifyModel('black-forest-labs/FLUX.1-schnell', { smoke: false, force: true });
    expect(result.smokeTest).toBeUndefined();
    expect(result.availability).toBe('available');
    expect(fetchMock.calls.some(c => c.url.includes('/images/generations'))).toBe(false);
  });

  it('verifies a whole task with bounded concurrency and records events', async () => {
    fetchMock = fakeHub({
      hub: (id) => hubMetadata({
        id,
        pipeline_tag: 'text-generation',
        inferenceProviderMapping: [{ provider: 'together', status: 'live', task: 'text-generation' }],
      }),
      router: (id) => routerModel({ id, providers: [{ provider: 'together', status: 'live', isFree: true }] }),
    });
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const results = await verifyAllModels({ task: 'text-to-image', smoke: false, force: true, concurrency: 4 });
    expect(results).toHaveLength(23);
    expect(new Set(results.map(r => r.task)).size).toBe(1);
    expect(results.every(r => r.task === 'text-to-image')).toBe(true);
    expect(registryOverview().configured.image).toBe(23);
    expect(recentModelEvents({ limit: 200 }).length).toBeGreaterThanOrEqual(20);
  });

  it('does not persist verification results when no token is configured', async () => {
    delete process.env.HF_TOKEN;
    process.env.AI_BACKEND = 'auto';
    fetchMock = mockFetch([() => jsonResponse({ error: 'should not be called' }, 500)]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await verifyModel('Qwen/Qwen2.5-7B-Instruct', { smoke: false, force: true });
    expect(result.availability).toBe('unverified');
    expect(result.verificationError).toMatch(/HF_TOKEN/);
    expect(fetchMock.calls).toHaveLength(0);
    // The registry still says "unverified" rather than claiming anything.
    expect(db().prepare('SELECT COUNT(*) AS c FROM ai_model_registry WHERE availabilityStatus = ?').get('unverified')).toEqual({ c: 78 });
  });
});
