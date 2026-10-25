/**
 * Agnes AI (primary provider) + Hugging Face (fallback) integration tests.
 *
 * Every request runs against an injected `fetch`: no test touches the network
 * and no test spends provider credits. Both the Agnes client and the Hugging
 * Face client receive the same mock router so provider hand-offs are exercised
 * end to end.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { freshDatabase, seedUser, db } from '../helpers/db';
import { __setFetchForTests as setHfFetch } from '@/lib/ai/huggingface-client';
import { __setFetchForTests as setAgnesFetch } from '@/lib/ai/agnes-client';
import { __setRetrySleepForTests } from '@/lib/ai/retry-policy';
import { __setAgnesSleepForTests } from '@/lib/ai/agnes-generation';
import { resetCircuitBreakersForTests } from '@/lib/ai/circuit-breaker';
import { resetVerificationCacheForTests } from '@/lib/ai/model-verification';
import { patchModel, syncRegistry } from '@/lib/ai/model-registry';
import { aiBackend, agnesConfigured, validateAiConfig } from '@/lib/ai/config';
import { agnesChatCompletion, agnesGenerateImage, nearestAgnesSize } from '@/lib/ai/agnes-client';
import { generateTextAgnes, generateStructuredAgnes, generateImageAgnes } from '@/lib/ai/agnes-generation';
import { generateTextDetailed, generateStructuredDetailed } from '@/lib/ai/text-generation';
import { generateImage } from '@/lib/ai/image-generation';
import { z } from 'zod';
import {
  BIG_PNG_BASE64, agnesChatSuccess, agnesHandler, agnesImageSuccess, chatHandler, chatSuccess,
  imageHandler, imageSuccessBase64, jsonResponse, mockFetch, useAgnesBackend, type MockRouter,
} from './helpers';

let restoreEnv: () => void;
let fetchMock: MockRouter;
let USER_ID = 'user_missing';

function makeEligible(ids: string[]) {
  syncRegistry();
  for (const id of ids) patchModel(id, { availabilityStatus: 'available', pricingStatus: 'free', provider: 'hf-inference' });
}

beforeEach(() => {
  freshDatabase();
  resetCircuitBreakersForTests();
  resetVerificationCacheForTests();
  restoreEnv = useAgnesBackend();
  __setRetrySleepForTests(async () => {});
  __setAgnesSleepForTests(async () => {});
  USER_ID = seedUser().id;
});

afterEach(() => {
  setHfFetch(null);
  setAgnesFetch(null);
  __setRetrySleepForTests(null);
  __setAgnesSleepForTests(null);
  restoreEnv();
});

describe('Agnes AI configuration', () => {
  it('is the active backend when AGNES_API_KEY is set', () => {
    expect(agnesConfigured()).toBe(true);
    expect(aiBackend()).toBe('agnes');
  });

  it('auto-selects Agnes over Hugging Face, and honours an explicit HF pin', () => {
    expect(aiBackend()).toBe('agnes');
    process.env.AI_BACKEND = 'huggingface';
    expect(aiBackend()).toBe('huggingface');
    delete process.env.AGNES_API_KEY;
    expect(aiBackend()).toBe('huggingface');
  });

  it('reports a pinned agnes backend without a key as a configuration problem', () => {
    delete process.env.AGNES_API_KEY;
    process.env.AI_BACKEND = 'agnes';
    const problems = validateAiConfig();
    expect(problems.some(p => p.includes('AGNES_API_KEY'))).toBe(true);
  });
});

describe('Agnes AI client', () => {
  it('maps requested dimensions onto the closest documented tier + ratio', () => {
    // Book covers are 3:4 (768×1024).
    expect(nearestAgnesSize(768, 1024)).toEqual({ size: '1K', ratio: '3:4', width: 864, height: 1152 });
    // Landscape 16:9.
    expect(nearestAgnesSize(1920, 1080)).toEqual({ size: '1K', ratio: '16:9', width: 1312, height: 736 });
    // Square.
    expect(nearestAgnesSize(1024, 1024, '2K')).toEqual({ size: '2K', ratio: '1:1', width: 2048, height: 2048 });
    // Portrait 9:16.
    expect(nearestAgnesSize(736, 1312)).toEqual({ size: '1K', ratio: '9:16', width: 736, height: 1312 });
  });

  it('sends chat completions to apihub with the Agnes bearer token and default model', async () => {
    fetchMock = mockFetch([agnesHandler((body, url) => {
      expect(url).toBe('https://apihub.agnes-ai.com/v1/chat/completions');
      expect(body.model).toBe('agnes-2.5-flash');
      expect(body.stream).toBe(false);
      expect(body.messages).toEqual([
        { role: 'system', content: 'You are a novelist.' },
        { role: 'user', content: 'Write a line.' },
      ]);
      return agnesChatSuccess('The harbour lights blinked once.');
    })]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const result = await agnesChatCompletion({
      systemPrompt: 'You are a novelist.',
      prompt: 'Write a line.',
      maxNewTokens: 128,
      temperature: 0.7,
    });

    expect(result.text).toBe('The harbour lights blinked once.');
    expect(result.model).toBe('agnes-2.5-flash');
    expect(result.provider).toBe('agnes-ai');
    expect(result.usage?.inputTokens).toBe(15);
    // The Authorization header carries the configured key (never logged).
    const headers = new Headers((fetchMock.inits[0] as RequestInit).headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer agnes_test_key_0123456789abcdef');
  });

  it('requests tier + ratio with Base64 output for images', async () => {
    fetchMock = mockFetch([agnesHandler((body, url) => {
      expect(url).toBe('https://apihub.agnes-ai.com/v1/images/generations');
      expect(body.model).toBe('agnes-image-2.5-flash');
      expect(body.size).toBe('1K');
      expect(body.ratio).toBe('3:4');
      expect(body.return_base64).toBe(true);
      expect(body.extra_body.response_format).toBe('b64_json');
      // response_format must never sit at the top level (documented failure mode).
      expect(body.response_format).toBeUndefined();
      expect(body.tags).toBeUndefined();
      return agnesImageSuccess();
    })]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const result = await agnesGenerateImage({ prompt: 'A lighthouse in a storm', width: 768, height: 1024 });

    expect(result.buffer.length).toBeGreaterThan(1_000);
    expect(result.mimeType).toBe('image/png');
    expect(result.provider).toBe('agnes-ai');
    expect(result.model).toBe('agnes-image-2.5-flash');
    expect(result.width).toBeGreaterThan(0);
  });

  it('rejects a non-image payload delivered with HTTP 200', async () => {
    fetchMock = mockFetch([agnesHandler(() => jsonResponse({ data: [{ url: null, b64_json: Buffer.from('not an image at all').toString('base64') }] }))]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    await expect(generateImageAgnes({ prompt: 'A cover', userId: USER_ID })).rejects.toThrow(/invalid image|not a recognized|image/i);
  });

  it('surfaces HTTP failures as AgnesHttpError with a redacted body', async () => {
    fetchMock = mockFetch([agnesHandler(() => jsonResponse({ error: 'bad key agnes_test_key_0123456789abcdef' }, 401))]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    await expect(agnesChatCompletion({ prompt: 'Hello' })).rejects.toThrow(/401/);
  });
});

describe('Agnes AI generation', () => {
  it('generates text and records usage attributed to agnes-ai', async () => {
    fetchMock = mockFetch([agnesHandler(() => agnesChatSuccess('Rain wrote its slow grammar on the window.'))]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const result = await generateTextAgnes({
      messages: [{ role: 'user', content: 'Write a sentence.' }],
      userId: USER_ID,
      taskType: 'chapter',
    });

    expect(result.text).toContain('grammar');
    expect(result.provider).toBe('agnes-ai');
    expect(result.attempts).toBe(1);

    const usage = db().prepare('SELECT * FROM ai_usage ORDER BY createdAt DESC LIMIT 1').get() as any;
    expect(usage.provider).toBe('agnes-ai');
    expect(usage.model).toBe('agnes-2.5-flash');
    expect(usage.source).toBe('agnes');
    expect(usage.promptTokens).toBe(15);
  });

  it('generates Zod-validated structured output', async () => {
    fetchMock = mockFetch([agnesHandler(body => {
      expect(body.response_format).toEqual({ type: 'json_object' });
      return agnesChatSuccess('```json\n{"title": "The Salt Road", "chapters": 12}\n```');
    })]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const schema = z.object({ title: z.string(), chapters: z.number() });
    const { data } = await generateStructuredAgnes({
      schema,
      messages: [{ role: 'user', content: 'Plan a novel.' }],
      userId: USER_ID,
      taskType: 'outline',
    });

    expect(data.title).toBe('The Salt Road');
    expect(data.chapters).toBe(12);
  });

  it('throws (never invents) when the structured response is unusable', async () => {
    fetchMock = mockFetch([agnesHandler(() => agnesChatSuccess('No JSON here, sorry.'))]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const schema = z.object({ title: z.string() });
    await expect(generateStructuredAgnes({
      schema,
      messages: [{ role: 'user', content: 'Plan a novel.' }],
      userId: USER_ID,
      taskType: 'outline',
    })).rejects.toThrow(/JSON/i);
  });

  it('generates a validated image with decoded PNG dimensions', async () => {
    fetchMock = mockFetch([agnesHandler(() => agnesImageSuccess())]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const result = await generateImageAgnes({ prompt: 'A cover', width: 832, height: 1248, userId: USER_ID, taskType: 'cover' });

    expect(result.mimeType).toBe('image/png');
    expect(result.provider).toBe('agnes-ai');
    expect(result.buffer.length).toBeGreaterThan(1_000);
    expect(result.cost?.currency).toBe('USD');
  });
});

describe('Agnes primary → Hugging Face fallback chains', () => {
  it('uses Agnes for text first and labels the source', async () => {
    fetchMock = mockFetch([agnesHandler(() => agnesChatSuccess('Agnes wrote this line.'))]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);
    setHfFetch(fetchMock as unknown as typeof fetch);

    const result = await generateTextDetailed({
      messages: [{ role: 'user', content: 'Write a sentence.' }],
      userId: USER_ID,
      taskType: 'chapter',
    });

    expect(result.meta.source).toBe('agnes');
    expect(result.meta.actualModel).toBe('agnes-2.5-flash');
    expect(result.meta.provider).toBe('agnes-ai');
    expect(fetchMock.callsTo('apihub.agnes-ai.com')).toBe(1);
    expect(fetchMock.callsTo('router.huggingface.co')).toBe(0);
  });

  it('falls back to the Hugging Face chain when Agnes fails', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct']);
    fetchMock = mockFetch([
      agnesHandler(() => jsonResponse({ error: 'upstream overload' }, 503)),
      chatHandler(() => chatSuccess('The fallback model wrote this.')),
    ]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);
    setHfFetch(fetchMock as unknown as typeof fetch);

    const result = await generateTextDetailed({
      messages: [{ role: 'user', content: 'Write a sentence.' }],
      userId: USER_ID,
      taskType: 'chapter',
    });

    expect(result.text).toContain('fallback model');
    expect(result.meta.source).toBe('huggingface');
    expect(result.meta.actualModel).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(fetchMock.callsTo('apihub.agnes-ai.com')).toBeGreaterThan(0);
    expect(fetchMock.callsTo('router.huggingface.co')).toBeGreaterThan(0);
  });

  it('falls back to Hugging Face for structured output when Agnes returns garbage', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct']);
    fetchMock = mockFetch([
      agnesHandler(() => agnesChatSuccess('I cannot produce JSON right now.')),
      chatHandler(() => chatSuccess('{"ok": true}')),
    ]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);
    setHfFetch(fetchMock as unknown as typeof fetch);

    const schema = z.object({ ok: z.boolean() });
    const { data, meta } = await generateStructuredDetailed(schema, {
      messages: [{ role: 'user', content: 'Return the flag.' }],
      userId: USER_ID,
      taskType: 'outline',
      fallback: { ok: false },
    });

    expect(data.ok).toBe(true);
    expect(meta.source).toBe('huggingface');
  });

  it('falls back to a Hugging Face image model when Agnes image generation fails', async () => {
    makeEligible(['black-forest-labs/FLUX.1-schnell']);
    fetchMock = mockFetch([
      agnesHandler(() => jsonResponse({ error: 'capacity exhausted' }, 503)),
      imageHandler(() => imageSuccessBase64()),
    ]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);
    setHfFetch(fetchMock as unknown as typeof fetch);

    const result = await generateImage({
      prompt: 'A lighthouse in a storm, oil painting',
      width: 768,
      height: 1024,
      userId: USER_ID,
      taskType: 'cover',
    });

    expect(result.image.length).toBeGreaterThan(1_000);
    expect(result.actualModelId).toBe('black-forest-labs/FLUX.1-schnell');
    expect(result.provider).toBe('hf-inference');
    expect(fetchMock.callsTo('router.huggingface.co')).toBeGreaterThan(0);
  });

  it('routes an explicit Agnes image model through Agnes even when Hugging Face is pinned', async () => {
    process.env.AI_BACKEND = 'huggingface';
    fetchMock = mockFetch([agnesHandler(body => {
      expect(body.model).toBe('agnes-image-2.5-flash');
      return agnesImageSuccess();
    })]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);
    setHfFetch(fetchMock as unknown as typeof fetch);

    const result = await generateImage({
      prompt: 'A cover',
      modelId: 'agnes-image-2.5-flash',
      userId: USER_ID,
      taskType: 'cover',
    });

    expect(result.provider).toBe('agnes-ai');
    expect(fetchMock.callsTo('router.huggingface.co')).toBe(0);
  });

  it('rejects an explicit Agnes image model when no key is configured', async () => {
    delete process.env.AGNES_API_KEY;
    await expect(generateImage({
      prompt: 'A cover',
      modelId: 'agnes-image-2.5-flash',
      userId: USER_ID,
      taskType: 'cover',
    })).rejects.toThrow(/AGNES_API_KEY/);
  });

  it('prefers the Hugging Face chain when the caller explicitly picks an HF model', async () => {
    makeEligible(['Qwen/Qwen2.5-7B-Instruct']);
    fetchMock = mockFetch([chatHandler(() => chatSuccess('The explicitly chosen model answered.'))]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);
    setHfFetch(fetchMock as unknown as typeof fetch);

    const result = await generateTextDetailed({
      messages: [{ role: 'user', content: 'Write a sentence.' }],
      model: 'Qwen/Qwen2.5-7B-Instruct',
      userId: USER_ID,
      taskType: 'chapter',
    });

    expect(result.meta.source).toBe('huggingface');
    expect(fetchMock.callsTo('apihub.agnes-ai.com')).toBe(0);
  });

  it('returns a labelled fallback (no HF configured) instead of pretending Agnes succeeded', async () => {
    restoreEnv();
    restoreEnv = useAgnesBackend({ fallback: false });
    fetchMock = mockFetch([agnesHandler(() => jsonResponse({ error: 'upstream overload' }, 503))]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);
    setHfFetch(fetchMock as unknown as typeof fetch);

    const result = await generateTextDetailed({
      messages: [{ role: 'user', content: 'Write a sentence.' }],
      userId: USER_ID,
      taskType: 'chapter',
      allowFallbackOnError: true,
      fallbackText: 'A labelled stub.',
    });

    expect(result.meta.source).toBe('fallback');
    expect(result.meta.usedFallback).toBe(true);
    expect(result.text).toBe('A labelled stub.');
  });

  it('throws when Agnes fails, HF is absent, and the caller refuses fallbacks', async () => {
    restoreEnv();
    restoreEnv = useAgnesBackend({ fallback: false });
    fetchMock = mockFetch([agnesHandler(() => jsonResponse({ error: 'upstream overload' }, 503))]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);
    setHfFetch(fetchMock as unknown as typeof fetch);

    await expect(generateTextDetailed({
      messages: [{ role: 'user', content: 'Write a sentence.' }],
      userId: USER_ID,
      taskType: 'chapter',
      allowFallbackOnError: false,
    })).rejects.toThrow();
  });
});

describe('BIG_PNG fixture sanity', () => {
  it('decodes as a real PNG', () => {
    const buffer = Buffer.from(BIG_PNG_BASE64, 'base64');
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
  });
});
