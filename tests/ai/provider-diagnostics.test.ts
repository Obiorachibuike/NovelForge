/**
 * Provider diagnostics: what a deployment reports about its AI backend, and
 * whether a live Agnes AI test can prove a credential works.
 *
 * The network is faked throughout — no test here spends provider credits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setFetchForTests as setAgnesFetch } from '@/lib/ai/agnes-client';
import { aiProviderSummary } from '@/lib/ai/config';
import { testAgnesProvider } from '@/lib/ai/provider-diagnostics';
import {
  agnesChatSuccess, agnesHandler, agnesImageSuccess, jsonResponse, mockFetch, useAgnesBackend, type MockRouter,
} from './helpers';

let restoreEnv: () => void;
let fetchMock: MockRouter;

const TEST_KEY = 'agnes_test_key_0123456789abcdef';

beforeEach(() => {
  restoreEnv = useAgnesBackend();
  setAgnesFetch(null);
});

afterEach(() => {
  setAgnesFetch(null);
  restoreEnv();
});

describe('aiProviderSummary', () => {
  it('reports Agnes AI as the live backend when AGNES_API_KEY is set', () => {
    const summary = aiProviderSummary();
    expect(summary.backend).toBe('agnes');
    expect(summary.pinnedBackend).toBeNull();
    expect(summary.providerOrder).toEqual(['agnes', 'huggingface', 'openai']);

    const agnes = summary.providers.find(p => p.name === 'agnes');
    expect(agnes).toMatchObject({
      role: 'primary',
      configured: true,
      models: { text: 'agnes-2.5-flash', image: 'agnes-image-2.5-flash' },
      endpoint: 'https://apihub.agnes-ai.com/v1',
    });
    expect(summary.providers.find(p => p.name === 'huggingface')?.configured).toBe(true);
    expect(summary.providers.find(p => p.name === 'openai')?.configured).toBe(false);
  });

  it('reports the fallback as the backend when the key is absent', () => {
    delete process.env.AGNES_API_KEY;
    const summary = aiProviderSummary();
    expect(summary.backend).toBe('huggingface');
    expect(summary.providers.find(p => p.name === 'agnes')?.configured).toBe(false);
  });

  it('never includes a credential value', () => {
    const serialised = JSON.stringify(aiProviderSummary());
    expect(serialised).not.toContain(TEST_KEY);
    expect(serialised).not.toContain('hf_test_token');
    expect(serialised).not.toMatch(/Bearer\s+\S+/);
  });

  it('surfaces a pinned backend and its misconfiguration by name only', () => {
    process.env.AI_BACKEND = 'agnes';
    delete process.env.AGNES_API_KEY;
    const summary = aiProviderSummary();
    expect(summary.pinnedBackend).toBe('agnes');
    expect(summary.backend).toBe('demo');
    expect(summary.problems.join(' ')).toContain('AGNES_API_KEY');
    expect(summary.problems.join(' ')).not.toContain(TEST_KEY);
  });
});

describe('testAgnesProvider', () => {
  it('proves a working text round-trip with model, latency and a sample', async () => {
    fetchMock = mockFetch([agnesHandler(() => agnesChatSuccess('NovelForge Agnes AI is online.'))]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const result = await testAgnesProvider('text');
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('agnes-ai');
    expect(result.model).toBe('agnes-2.5-flash');
    expect(result.sample).toContain('online');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock.callsTo('/chat/completions')).toBe(1);
    // Cheap by construction: a tiny completion, not a chapter.
    expect(fetchMock.calls[0].body.max_tokens).toBeLessThanOrEqual(64);
  });

  it('classifies a rejected key without echoing it', async () => {
    fetchMock = mockFetch([agnesHandler(() => jsonResponse({ error: { message: 'invalid api key' } }, 401))]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const result = await testAgnesProvider('text');
    expect(result.ok).toBe(false);
    expect(result.error?.category).toBe('authentication_failed');
    expect(result.error?.status).toBe(401);
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });

  it('reports a missing key instead of attempting a request', async () => {
    delete process.env.AGNES_API_KEY;
    fetchMock = mockFetch([]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const result = await testAgnesProvider('text');
    expect(result.ok).toBe(false);
    expect(result.error?.category).toBe('not_configured');
    expect(result.error?.message).toContain('redeploy');
    expect(fetchMock.calls.length).toBe(0);
  });

  it('refuses a live image test unless image health checks are enabled', async () => {
    delete process.env.AI_ALLOW_LIVE_IMAGE_HEALTH_CHECKS;
    fetchMock = mockFetch([]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const result = await testAgnesProvider('image');
    expect(result.ok).toBe(false);
    expect(result.error?.category).toBe('disabled');
    expect(fetchMock.calls.length).toBe(0);
  });

  it('reports a successful image test in bytes when explicitly enabled', async () => {
    process.env.AI_ALLOW_LIVE_IMAGE_HEALTH_CHECKS = 'true';
    fetchMock = mockFetch([agnesHandler(() => agnesImageSuccess())]);
    setAgnesFetch(fetchMock as unknown as typeof fetch);

    const result = await testAgnesProvider('image');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('agnes-image-2.5-flash');
    expect(result.imageBytes).toBeGreaterThan(0);
  });
});
