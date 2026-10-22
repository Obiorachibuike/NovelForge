import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { freshDatabase, seedUser, db } from '../helpers/db';
import { __setFetchForTests } from '@/lib/ai/huggingface-client';
import { __setRetrySleepForTests } from '@/lib/ai/retry-policy';
import { resetCircuitBreakersForTests } from '@/lib/ai/circuit-breaker';
import { resetVerificationCacheForTests } from '@/lib/ai/model-verification';
import { patchModel, recentModelEvents, syncRegistry } from '@/lib/ai/model-registry';
import { generateImageHuggingFace } from '@/lib/ai/image-generation';
import { generateCovers } from '@/services/images/service';
import { textToImageModels as TEXT_TO_IMAGE_MODELS } from '@/lib/ai/models';
import {
  BIG_PNG_BASE64, imageHandler, imageSuccessBase64, jsonResponse, mockFetch, PNG_BASE64, useHuggingFaceBackend,
  type MockRouter,
} from './helpers';

let restoreEnv: () => void;
let fetchMock: MockRouter;
let USER_ID = 'user_missing';

function makeEligible(ids: string[]) {
  syncRegistry();
  for (const id of ids) patchModel(id, { availabilityStatus: 'available', pricingStatus: 'free', provider: 'fal-ai' });
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

describe('Hugging Face image generation', () => {
  it('posts to the OpenAI-compatible images endpoint and stores the bytes', async () => {
    makeEligible(['black-forest-labs/FLUX.1-schnell']);
    fetchMock = mockFetch([imageHandler(() => imageSuccessBase64(BIG_PNG_BASE64, 'fal-ai'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateImageHuggingFace({
      prompt: 'A lighthouse in a storm, oil painting',
      negativePrompt: 'blurry',
      width: 768,
      height: 1024,
      userId: USER_ID,
      taskType: 'cover',
    });

    expect(fetchMock.calls[0].url).toBe('https://router.huggingface.co/v1/images/generations');
    expect(fetchMock.calls[0].body.response_format).toBe('b64_json');
    expect(fetchMock.calls[0].body.model).toBe('black-forest-labs/FLUX.1-schnell');
    expect(fetchMock.calls[0].body.negative_prompt).toBe('blurry');
    expect(result.image.length).toBeGreaterThan(1_000);
    expect(result.mimeType).toBe('image/png');
    expect(result.actualModelId).toBe('black-forest-labs/FLUX.1-schnell');
    expect(result.provider).toBe('fal-ai');
    expect(result.fallbackUsed).toBe(false);

    const usage = db().prepare('SELECT * FROM ai_usage ORDER BY createdAt DESC LIMIT 1').get() as any;
    expect(usage.taskType).toBe('cover');
    expect(usage.imageWidth).toBe(768);
    expect(usage.actualModel).toBe('black-forest-labs/FLUX.1-schnell');
  });

  it('rejects an error body delivered with HTTP 200 instead of storing it as an image', async () => {
    makeEligible(['black-forest-labs/FLUX.1-schnell', 'stabilityai/stable-diffusion-xl-base-1.0']);
    fetchMock = mockFetch([
      imageHandler((body) =>
        body.model === 'black-forest-labs/FLUX.1-schnell'
          ? jsonResponse({ error: 'Internal server error' }, 200)
          : imageSuccessBase64(),
      ),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateImageHuggingFace({
      prompt: 'A cover',
      modelId: 'black-forest-labs/FLUX.1-schnell',
      userId: USER_ID, taskType: 'cover',
    });
    expect(result.actualModelId).toBe('stabilityai/stable-diffusion-xl-base-1.0');
    expect(result.attempts_detail?.[0].category).toBe('invalid_image');
  });

  it('rejects an image that is too small to be a render', async () => {
    makeEligible(['black-forest-labs/FLUX.1-schnell', 'stabilityai/stable-diffusion-xl-base-1.0']);
    fetchMock = mockFetch([
      imageHandler((body) =>
        body.model === 'black-forest-labs/FLUX.1-schnell' ? imageSuccessBase64(PNG_BASE64) : imageSuccessBase64(),
      ),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateImageHuggingFace({
      prompt: 'A cover',
      modelId: 'black-forest-labs/FLUX.1-schnell',
      userId: USER_ID, taskType: 'cover',
    });
    expect(result.actualModelId).toBe('stabilityai/stable-diffusion-xl-base-1.0');
    expect(result.attempts_detail?.[0].modelId).toBe('black-forest-labs/FLUX.1-schnell');
  });

  it('never falls back from an image request to a text model', async () => {
    makeEligible(TEXT_TO_IMAGE_MODELS.slice(0, 6));
    // Patch every text model to look eligible too: selection must still ignore them.
    syncRegistry();
    patchModel('Qwen/Qwen2.5-7B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });

    let requestedModels: string[] = [];
    fetchMock = mockFetch([
      imageHandler((body) => {
        requestedModels.push(body.model);
        return jsonResponse({ error: 'Model is currently unavailable' }, 503);
      }),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      generateImageHuggingFace({ prompt: 'A cover', userId: USER_ID, taskType: 'cover' }),
    ).rejects.toMatchObject({ status: 503 });

    for (const model of requestedModels) {
      expect(TEXT_TO_IMAGE_MODELS).toContain(model);
    }
  });

  it('marks an unsupported architecture unsupported instead of retrying forever', async () => {
    makeEligible(['XLabs-AI/flux-RealismLora', 'black-forest-labs/FLUX.1-schnell']);
    fetchMock = mockFetch([
      imageHandler((body, url) =>
        decodeURIComponent(url).includes('XLabs-AI/flux-RealismLora') || body?.model === 'XLabs-AI/flux-RealismLora'
          ? jsonResponse({ error: 'Model XLabs-AI/flux-RealismLora is not supported for task text-to-image' }, 400)
          : imageSuccessBase64(),
      ),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateImageHuggingFace({
      prompt: 'A portrait',
      modelId: 'XLabs-AI/flux-RealismLora',
      userId: USER_ID, taskType: 'cover',
    });
    expect(result.actualModelId).toBe('black-forest-labs/FLUX.1-schnell');
    const events = recentModelEvents({ onlyFailures: true, modelId: 'XLabs-AI/flux-RealismLora' });
    expect(events[0].category).toMatch(/unsupported/);
  });

  it('falls back to the provider-native task route when the images route is unavailable', async () => {
    makeEligible(['black-forest-labs/FLUX.1-schnell']);
    fetchMock = mockFetch([
      (url) => (url.includes('/images/generations') ? jsonResponse({ error: 'Not found' }, 404) : null),
      imageHandler(() => imageSuccessBase64(BIG_PNG_BASE64, 'hf-inference')),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateImageHuggingFace({
      prompt: 'A portrait',
      modelId: 'black-forest-labs/FLUX.1-schnell',
      userId: USER_ID, taskType: 'cover',
      allowFallback: false,
    });
    expect(result.image.length).toBeGreaterThan(1_000);
    expect(fetchMock.calls.some(c => c.url.includes('/images/generations'))).toBe(true);
    expect(fetchMock.calls.some(c => c.url.includes('/models/black-forest-labs/FLUX.1-schnell'))).toBe(true);
  });

  it('classifies gated access and moves to a model the account can use', async () => {
    makeEligible(['black-forest-labs/FLUX.1-dev', 'black-forest-labs/FLUX.1-schnell']);
    fetchMock = mockFetch([
      imageHandler((body) =>
        body.model === 'black-forest-labs/FLUX.1-dev'
          ? jsonResponse({ error: 'Access to model is restricted: gated repository' }, 403)
          : imageSuccessBase64(),
      ),
    ]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateImageHuggingFace({
      prompt: 'A portrait',
      modelId: 'black-forest-labs/FLUX.1-dev',
      userId: USER_ID, taskType: 'cover',
    });
    expect(result.actualModelId).toBe('black-forest-labs/FLUX.1-schnell');
    const events = recentModelEvents({ onlyFailures: true, modelId: 'black-forest-labs/FLUX.1-dev' });
    expect(events[0].category).toBe('gated_model');
  });

  it('reports a clear failure when every image model fails', async () => {
    makeEligible(TEXT_TO_IMAGE_MODELS.slice(0, 4));
    fetchMock = mockFetch([imageHandler(() => jsonResponse({ error: 'Service overloaded' }, 503))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const err: any = await generateImageHuggingFace({
      prompt: 'A cover', userId: USER_ID, taskType: 'cover',
    }).catch(e => e);
    expect(err.code).toBe('provider_outage');
    expect(err.message).toMatch(/Check model availability/i);
  });

  it('clamps oversized dimensions to the configured maximum edge', async () => {
    process.env.AI_MAX_IMAGE_EDGE = '1024';
    makeEligible(['black-forest-labs/FLUX.1-schnell']);
    fetchMock = mockFetch([imageHandler(() => imageSuccessBase64())]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    await generateImageHuggingFace({ prompt: 'A cover', width: 4096, height: 4096, userId: USER_ID, taskType: 'cover' });
    expect(fetchMock.calls[0].body.size).toBe('1024x1024');
  });
});

describe('cover generation through the existing image service', () => {
  it('uses hosted inference when configured and records the model on the asset row', async () => {
    const { seedNovel } = await import('../helpers/db');
    const novel = seedNovel(USER_ID, { title: 'The Lighthouse Codex', genre: 'Fantasy' });
    makeEligible(['black-forest-labs/FLUX.1-schnell']);
    fetchMock = mockFetch([imageHandler(() => imageSuccessBase64(BIG_PNG_BASE64, 'fal-ai'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const covers = await generateCovers(USER_ID, novel.id, 'A lighthouse at dusk', 1, {
      imageModel: 'black-forest-labs/FLUX.1-schnell',
      allowFallback: true,
    });

    expect(covers).toHaveLength(1);
    expect(covers[0].actualModel).toBe('black-forest-labs/FLUX.1-schnell');
    expect(covers[0].source).toBe('huggingface');
    const asset = db().prepare('SELECT * FROM image_assets ORDER BY createdAt DESC LIMIT 1').get() as any;
    expect(asset.model).toBe('black-forest-labs/FLUX.1-schnell');
    expect(asset.kind).toBe('cover');
  });

  it('labels a substituted concept honestly instead of passing it off as a generated image', async () => {
    const { seedNovel } = await import('../helpers/db');
    const novel = seedNovel(USER_ID, { title: 'Failed Cover Novel' });
    makeEligible(['black-forest-labs/FLUX.1-schnell']);
    fetchMock = mockFetch([imageHandler(() => jsonResponse({ error: 'boom' }, 500))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const covers = await generateCovers(USER_ID, novel.id, 'A lighthouse', 1, {
      imageModel: 'black-forest-labs/FLUX.1-schnell',
    });
    // A substitute is only acceptable when it is labelled as one, with the reason.
    expect(covers[0].source).toBe('svg-fallback');
    expect(covers[0].provider).toBe('svg-fallback');
    expect(covers[0].fallbackReason).toBeTruthy();
    expect(covers[0].actualModel).toBeUndefined();
    const asset = db().prepare('SELECT * FROM image_assets WHERE novelId = ? ORDER BY createdAt DESC LIMIT 1').get(novel.id) as any;
    expect(asset.provider).toBe('svg-fallback');
    expect(asset.model).toBeNull();
  });
});
