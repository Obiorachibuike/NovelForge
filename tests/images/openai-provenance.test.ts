import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, freshDatabase, seedNovel, seedUser } from '../helpers/db';

const provider = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('@/lib/ai/provider', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai/provider')>('@/lib/ai/provider');
  return { ...actual, getOpenAI: () => ({ images: { generate: provider.generate } }) };
});

import { generateCovers } from '@/services/images/service';

let restoreEnv: () => void;
let userId: string;
let novelId: string;

beforeEach(() => {
  const previous = { ...process.env } as Record<string, string | undefined>;
  restoreEnv = () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  };
  delete process.env.AGNES_API_KEY;
  delete process.env.HF_TOKEN;
  delete process.env.HUGGINGFACEHUB_API_TOKEN;
  delete process.env.AI_BACKEND;
  delete process.env.AI_PROVIDER;
  process.env.AI_DEMO_MODE = 'false';
  process.env.AI_FALLBACK_ENABLED = 'true';
  process.env.OPENAI_API_KEY = 'fake-test-key';
  process.env.OPENAI_IMAGE_MODEL = 'gpt-image-1';
  freshDatabase();
  userId = seedUser().id;
  novelId = seedNovel(userId).id;
  provider.generate.mockReset().mockResolvedValue({ data: [{ url: 'https://example.test/cover.png' }] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('89504e470d0a1a0a', 'hex'))));
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv();
});

describe('OpenAI cover provenance', () => {
  it('labels a selected hosted model replaced by OpenAI and persists the actual model', async () => {
    const [cover] = await generateCovers(userId, novelId, 'A cover', 1, { imageModel: 'agnes-image-2.5-flash', allowFallback: true });
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-image-1' }));
    expect(cover).toMatchObject({ provider: 'openai', requestedModel: 'agnes-image-2.5-flash', actualModel: 'gpt-image-1', modelFallbackUsed: true });
    const row = db().prepare('SELECT model, requestedModel, meta FROM image_assets WHERE id=?').get(cover.imageId) as any;
    expect(row).toMatchObject({ model: 'gpt-image-1', requestedModel: 'agnes-image-2.5-flash' });
    expect(JSON.parse(row.meta).modelFallbackUsed).toBe(true);
  });

  it('does not silently replace the selected model when fallback is disabled', async () => {
    await expect(generateCovers(userId, novelId, 'A cover', 1, { imageModel: 'agnes-image-2.5-flash', allowFallback: false }))
      .rejects.toMatchObject({ code: 'provider_model_mismatch' });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(db().prepare('SELECT COUNT(*) AS c FROM image_assets WHERE novelId=?').get(novelId)).toEqual({ c: 0 });
  });
});
