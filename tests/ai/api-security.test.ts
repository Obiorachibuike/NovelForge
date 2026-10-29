import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { freshDatabase, seedUser, seedNovel, db, jsonRequest, readJson } from '../helpers/db';
import { __setFetchForTests } from '@/lib/ai/huggingface-client';
import { __setRetrySleepForTests } from '@/lib/ai/retry-policy';
import { resetCircuitBreakersForTests } from '@/lib/ai/circuit-breaker';
import { resetVerificationCacheForTests } from '@/lib/ai/model-verification';
import { patchModel, syncRegistry } from '@/lib/ai/model-registry';
import { resetAiRateLimitsForTests } from '@/lib/ai/rate-limit';
import {
  BIG_PNG_BASE64, chatHandler, chatSuccess, imageHandler, imageSuccessBase64, jsonResponse, mockFetch,
  useHuggingFaceBackend, type MockRouter,
} from './helpers';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { GET as listModels, } from '@/app/api/ai/models/route';
import { GET as getModel } from '@/app/api/ai/models/[id]/route';
import { GET as textModelsRoute } from '@/app/api/ai/models/text/route';
import { GET as imageModelsRoute } from '@/app/api/ai/models/image/route';
import { POST as verifyRoute } from '@/app/api/ai/models/[id]/verify/route';
import { POST as enableRoute } from '@/app/api/ai/models/[id]/enable/route';
import { POST as disableRoute } from '@/app/api/ai/models/[id]/disable/route';
import { POST as setPrimaryRoute, DELETE as clearPrimaryRoute } from '@/app/api/ai/models/[id]/primary/route';
import { POST as generateTextRoute } from '@/app/api/ai/generate/text/route';
import { POST as generateImageRoute } from '@/app/api/ai/generate/image/route';
import { GET as jobsRoute } from '@/app/api/ai/jobs/route';
import { GET as adminOverviewRoute } from '@/app/api/admin/ai/overview/route';
import { GET as adminUsageRoute } from '@/app/api/admin/ai/usage/route';
import { GET as adminFailuresRoute } from '@/app/api/admin/ai/failures/route';

const TOKEN = 'hf_test_token_0123456789abcdef';

let user: { id: string; email: string; name: string };
let admin: { id: string; email: string; name: string };
let novel: { id: string; userId: string };
let restoreEnv: () => void;
let fetchMock: MockRouter;

beforeEach(() => {
  freshDatabase();
  resetCircuitBreakersForTests();
  resetVerificationCacheForTests();
  resetAiRateLimitsForTests();
  restoreEnv = useHuggingFaceBackend();
  __setRetrySleepForTests(async () => {});
  user = seedUser({ name: 'Writer' });
  admin = seedUser({ name: 'Root', email: 'admin_root@example.com' });
  db().prepare('UPDATE users SET role=? WHERE id=?').run('admin', admin.id);
  novel = seedNovel(user.id, {});
  session.userId = user.id;
  syncRegistry();
});

afterEach(() => {
  __setFetchForTests(null);
  __setRetrySleepForTests(null);
  resetCircuitBreakersForTests();
  resetAiRateLimitsForTests();
  session.userId = null;
  restoreEnv();
});

/** Fails the test if the secret leaks into a serialized response. */
function assertNoSecret(payload: unknown) {
  const text = JSON.stringify(payload ?? {});
  expect(text).not.toContain(TOKEN);
  expect(text.toLowerCase()).not.toMatch(/bearer\s+hf_/);
}

describe('authentication and authorisation', () => {
  it('rejects anonymous access to the model catalogue', async () => {
    session.userId = null;
    const res = await listModels(jsonRequest('/api/ai/models'));
    expect(res.status).toBe(401);
  });

  it('rejects anonymous generation requests', async () => {
    session.userId = null;
    const res = await generateTextRoute(jsonRequest('/api/ai/generate/text', { messages: [{ role: 'user', content: 'hi' }] }, { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(fetchMock?.calls?.length ?? 0).toBe(0);
  });

  it('hides the administrator console from ordinary users', async () => {
    const res = await adminOverviewRoute(jsonRequest('/api/admin/ai/overview'));
    expect(res.status).toBe(403);
    expect((await readJson(res)).code).toBe('admin_only');
  });

  it('lets an administrator read the console without exposing the token', async () => {
    session.userId = admin.id;
    const res = await adminOverviewRoute(jsonRequest('/api/admin/ai/overview'));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.overview.configured).toEqual({ text: 55, image: 23, total: 78 });
    expect(body.configuration.huggingFaceConfigured).toBe(true);
    expect(body.configuration.routerBaseUrl).toContain('router.huggingface.co');
    assertNoSecret(body);

    const usage = await readJson(await adminUsageRoute(jsonRequest('/api/admin/ai/usage')));
    expect(usage.windowHours).toBeGreaterThan(0);
    assertNoSecret(usage);

    const failures = await readJson(await adminFailuresRoute(jsonRequest('/api/admin/ai/failures')));
    expect(Array.isArray(failures.failures ?? failures.events ?? failures)).toBe(true);
    assertNoSecret(failures);
  });

  it('refuses model administration actions for non-admins', async () => {
    for (const [name, call] of [
      ['verify', () => verifyRoute(jsonRequest(`/api/ai/models/Qwen/Qwen2.5-7B-Instruct/verify`, { smoke: false }, { method: 'POST' }), { params: { id: 'Qwen/Qwen2.5-7B-Instruct' } })],
      ['disable', () => disableRoute(jsonRequest(`/api/ai/models/Qwen/Qwen2.5-7B-Instruct/disable`, { reason: 'slow' }, { method: 'POST' }), { params: { id: 'Qwen/Qwen2.5-7B-Instruct' } })],
      ['set primary', () => setPrimaryRoute(jsonRequest(`/api/ai/models/Qwen/Qwen2.5-7B-Instruct/primary`, {}, { method: 'POST' }), { params: { id: 'Qwen/Qwen2.5-7B-Instruct' } })],
    ] as Array<[string, () => Promise<Response>]>) {
      const res = await call();
      expect(res.status, name).toBe(403);
    }
    expect(db().prepare('SELECT enabled FROM ai_model_registry WHERE id=?').get('Qwen/Qwen2.5-7B-Instruct')).toEqual({ enabled: 1 });
    expect(db().prepare('SELECT COUNT(*) AS c FROM ai_model_registry WHERE isPrimary=1').get()).toEqual({ c: 0 });
  });

  it('lets an administrator enable, disable and set a primary model', async () => {
    session.userId = admin.id;
    const disabled = await disableRoute(jsonRequest('/api/ai/models/Qwen/Qwen2.5-7B-Instruct/disable', { reason: 'Too slow for long chapters' }, { method: 'POST' }), { params: { id: 'Qwen/Qwen2.5-7B-Instruct' } });
    expect(disabled.status).toBe(200);
    expect((db().prepare('SELECT enabled, disabledReason FROM ai_model_registry WHERE id=?').get('Qwen/Qwen2.5-7B-Instruct') as any).disabledReason).toBe('Too slow for long chapters');

    const enabled = await enableRoute(jsonRequest('/api/ai/models/Qwen/Qwen2.5-7B-Instruct/enable', {}, { method: 'POST' }), { params: { id: 'Qwen/Qwen2.5-7B-Instruct' } });
    expect(enabled.status).toBe(200);
    expect((db().prepare('SELECT enabled FROM ai_model_registry WHERE id=?').get('Qwen/Qwen2.5-7B-Instruct') as any).enabled).toBe(1);

    const primary = await setPrimaryRoute(jsonRequest('/api/ai/models/Qwen/Qwen2.5-7B-Instruct/primary', {}, { method: 'POST' }), { params: { id: 'Qwen/Qwen2.5-7B-Instruct' } });
    expect(primary.status).toBe(200);
    expect((db().prepare('SELECT COUNT(*) AS c FROM ai_model_registry WHERE isPrimary=1').get() as any).c).toBe(1);

    const cleared = await clearPrimaryRoute(jsonRequest('/api/ai/models/Qwen/Qwen2.5-7B-Instruct/primary', {}, { method: 'DELETE' }), { params: { id: 'Qwen/Qwen2.5-7B-Instruct' } });
    expect(cleared.status).toBe(200);
    expect((db().prepare('SELECT COUNT(*) AS c FROM ai_model_registry WHERE isPrimary=1').get() as any).c).toBe(0);
  });
});

describe('model id validation (no open proxy)', () => {
  it('rejects an unregistered repository id for generation', async () => {
    const res = await generateTextRoute(jsonRequest('/api/ai/generate/text', {
      prompt: 'Write something about a lighthouse.',
      modelId: 'some-org/some-model',
    }, { method: 'POST' }));
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('unknown_model');
  });

  it('rejects a text model id on the image endpoint', async () => {
    const res = await generateImageRoute(jsonRequest('/api/ai/generate/image', {
      prompt: 'A lighthouse at dusk',
      modelId: 'Qwen/Qwen2.5-7B-Instruct',
    }, { method: 'POST' }));
    expect(res.status).toBe(400);
  });

  it('rejects an unregistered id for a model detail lookup', async () => {
    const res = await getModel(jsonRequest('/api/ai/models/not-a-real/model'), { params: { id: 'not-a-real/model' } });
    expect(res.status).toBe(404);
  });

  it('accepts a registered image model and returns validated bytes', async () => {
    patchModel('black-forest-labs/FLUX.1-schnell', { availabilityStatus: 'available', pricingStatus: 'free' });
    fetchMock = mockFetch([imageHandler(() => imageSuccessBase64(BIG_PNG_BASE64, 'fal-ai'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await generateImageRoute(jsonRequest('/api/ai/generate/image', {
      prompt: 'A lighthouse at dusk, painterly',
      modelId: 'black-forest-labs/FLUX.1-schnell',
      width: 768,
      height: 1024,
    }, { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.imageBase64).toBeTruthy();
    expect(body.mimeType).toBe('image/png');
    expect(body.actualModelId).toBe('black-forest-labs/FLUX.1-schnell');
    assertNoSecret(body);
  });

  it('generates text with a registered model and reports provenance', async () => {
    patchModel('Qwen/Qwen2.5-7B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    fetchMock = mockFetch([chatHandler(() => chatSuccess('Prose from the hosted model.', {}, 'together'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await generateTextRoute(jsonRequest('/api/ai/generate/text', {
      prompt: 'Write a paragraph about a lighthouse.',
      modelId: 'Qwen/Qwen2.5-7B-Instruct',
    }, { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.text).toContain('hosted model');
    expect(body.actualModelId).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(body.provider).toBe('together');
    assertNoSecret(body);
  });

  it('returns 503 when no hosted inference backend (Agnes/HF) is configured', async () => {
    delete process.env.HF_TOKEN;
    delete process.env.AGNES_API_KEY;
    process.env.AI_BACKEND = 'auto';
    const res = await generateTextRoute(jsonRequest('/api/ai/generate/text', {
      prompt: 'Write a paragraph about a lighthouse.',
      modelId: 'Qwen/Qwen2.5-7B-Instruct',
    }, { method: 'POST' }));
    expect(res.status).toBe(503);
    expect((await readJson(res)).code).toBe('hosted_inference_not_configured');
  });
});

describe('catalogue endpoints', () => {
  it('lists the 70 configured models with honest availability metadata', async () => {
    const res = await listModels(jsonRequest('/api/ai/models?limit=200&overview=true'));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.models.length).toBe(78);
    expect(body.models.every((m: any) => m.availability === 'Unverified' || m.availability === 'Not verified')).toBeFalsy;
    expect(body.models.filter((m: any) => m.task === 'text-generation')).toHaveLength(50);
    expect(body.models.filter((m: any) => m.task === 'text-to-image')).toHaveLength(20);
    // Nothing is claimed to be operational before verification.
    expect(body.overview.hostedInferenceSupported).toBe(0);
    expect(body.overview.successfullyTested).toBe(0);
    assertNoSecret(body);
  });

  it('separates text and image selectors', async () => {
    const text = await readJson(await textModelsRoute(jsonRequest('/api/ai/models/text')));
    const image = await readJson(await imageModelsRoute(jsonRequest('/api/ai/models/image')));
    expect(text.models.every((m: any) => m.task === 'text-generation')).toBe(true);
    expect(image.models.every((m: any) => m.task === 'text-to-image')).toBe(true);
    expect(text.count).toBe(55);
    expect(image.count).toBe(23);
  });

  it('does not call the provider when serving the catalogue', async () => {
    fetchMock = mockFetch([() => jsonResponse({ error: 'should not be called' }, 500)]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);
    await listModels(jsonRequest('/api/ai/models?limit=200&overview=true'));
    await textModelsRoute(jsonRequest('/api/ai/models/text'));
    await imageModelsRoute(jsonRequest('/api/ai/models/image'));
    expect(fetchMock.calls).toHaveLength(0);
  });

  it('exposes one model with its limitations and adapter metadata', async () => {
    const res = await getModel(jsonRequest('/api/ai/models/XLabs-AI/flux-RealismLora'), { params: { id: 'XLabs-AI/flux-RealismLora' } });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.model.id).toBe('XLabs-AI/flux-RealismLora');
    expect(Array.isArray(body.limitations)).toBe(true);
    expect((body.limitations as string[]).join(' ')).toMatch(/LoRA adapter weights/i);
    assertNoSecret(body);
  });
});

describe('usage visibility and limits', () => {
  it('shows a user their own jobs with the model that actually ran', async () => {
    db().prepare(`INSERT INTO generation_jobs (id,userId,novelId,taskType,payload,status,attempts,maxAttempts,createdAt,updatedAt,requestedModel,actualModel,provider,fallbackCount)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('job_sec_1', user.id, novel.id, 'chapter', '{}', 'completed', 1, 3, new Date().toISOString(), new Date().toISOString(),
        'Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct', 'together', 1);
    const body = await readJson(await jobsRoute(jsonRequest('/api/ai/jobs')));
    const jobs = body.jobs ?? body;
    const job = jobs.find((j: any) => j.id === 'job_sec_1');
    expect(job.requestedModel).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(job.actualModel).toBe('Qwen/Qwen2.5-14B-Instruct');
    expect(job.provider).toBe('together');
    assertNoSecret(body);
  });

  it('does not leak other users jobs', async () => {
    const other = seedUser({ email: 'other_writer@example.com' });
    db().prepare(`INSERT INTO generation_jobs (id,userId,novelId,taskType,payload,status,attempts,maxAttempts,createdAt,updatedAt,requestedModel,actualModel)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('job_other', other.id, novel.id, 'chapter', '{}', 'completed', 1, 3, new Date().toISOString(), new Date().toISOString(), 'auto', 'Qwen/Qwen2.5-7B-Instruct');
    const body = await readJson(await jobsRoute(jsonRequest('/api/ai/jobs')));
    const jobs = body.jobs ?? body;
    expect(jobs.some((j: any) => j.id === 'job_other')).toBe(false);
  });

  it('rate limits hosted text generation per user', async () => {
    process.env.AI_MAX_TEXT_REQUESTS_PER_USER_PER_HOUR = '1';
    resetAiRateLimitsForTests();
    patchModel('Qwen/Qwen2.5-7B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free' });
    fetchMock = mockFetch([chatHandler(() => chatSuccess('Prose.', {}, 'together'))]);
    __setFetchForTests(fetchMock as unknown as typeof fetch);

    const first = await generateTextRoute(jsonRequest('/api/ai/generate/text', {
      prompt: 'Write a sentence about the sea.', modelId: 'Qwen/Qwen2.5-7B-Instruct',
    }, { method: 'POST' }));
    expect(first.status).toBe(200);

    const second = await generateTextRoute(jsonRequest('/api/ai/generate/text', {
      prompt: 'Write another sentence about the sea.', modelId: 'Qwen/Qwen2.5-7B-Instruct',
    }, { method: 'POST' }));
    expect(second.status).toBe(429);
    expect(fetchMock.callsTo('/chat/completions')).toBe(1);
  });
});
