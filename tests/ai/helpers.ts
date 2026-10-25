/**
 * Test helpers for the hosted-inference layer.
 *
 * Every test here runs against an injected `fetch`: no test may touch the
 * network or spend provider credits.
 */
import { vi } from 'vitest';

export type MockHandler = (url: string, init: RequestInit) => Response | Promise<Response> | null;

export interface MockRouter {
  (url: string, init: RequestInit): Promise<Response>;
  calls: Array<{ url: string; body?: any }>;
  /** The RequestInit of every call, index-aligned with `calls`. */
  inits: RequestInit[];
  callsTo(fragment: string): number;
}

/** Builds a fake `fetch` from an ordered list of handlers (first match wins). */
export function mockFetch(handlers: MockHandler[]): MockRouter {
  const calls: Array<{ url: string; body?: any }> = [];
  const inits: RequestInit[] = [];
  const router = (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? safeJson(init.body) : undefined;
    calls.push({ url: String(url), body });
    inits.push(init);
    for (const handler of handlers) {
      const result = await handler(String(url), init);
      if (result) return result;
    }
    return jsonResponse({ error: 'Unhandled request in test' }, 500);
  }) as MockRouter;
  router.calls = calls;
  router.inits = inits;
  router.callsTo = (fragment: string) => calls.filter(c => c.url.includes(fragment)).length;
  return router;
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function textResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

/** Chat-completion handler: `decide(url, body)` returns a Response or null. */
export function chatHandler(
  decide: (body: any, url: string) => Response | null | Promise<Response | null>,
): MockHandler {
  return (url, init) => {
    if (!url.includes('/chat/completions')) return null;
    const body = safeJson(String(init.body ?? '{}'));
    return decide(body, url);
  };
}

export function chatSuccess(text: string, extra: Record<string, unknown> = {}, provider = 'hf-inference'): Response {
  return jsonResponse(
    {
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
      ...extra,
    },
    200,
    { 'x-inference-provider': provider },
  );
}

/** Minimal valid PNG (1×1). Too small to pass the size gate on its own. */
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/**
 * A payload that passes image validation: PNG magic bytes plus padding, so the
 * response is a real image format and large enough to be a plausible render.
 */
export const BIG_PNG_BASE64 = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.alloc(2_048, 7),
]).toString('base64');

export function imageSuccessBase64(b64 = BIG_PNG_BASE64, provider = 'hf-inference'): Response {
  return jsonResponse({ data: [{ b64_json: b64 }] }, 200, { 'x-inference-provider': provider });
}

/** Raw image bytes response (used by provider-native transports). */
export function rawImageResponse(bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(2_048, 3)]), provider = 'fal-ai'): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png', 'x-inference-provider': provider } });
}

export function imageHandler(
  decide: (body: any, url: string) => Response | null | Promise<Response | null>,
): MockHandler {
  return (url, init) => {
    if (!url.includes('/images/generations') && !url.includes('/models/')) return null;
    const body = safeJson(String(init.body ?? '{}'));
    return decide(body, url);
  };
}

export function hubMetadata(body: Record<string, unknown>, status = 200): Response {
  return jsonResponse(body, status);
}

/**
 * Router catalog response. Tests pass the camelCase fields the client exposes;
 * this converts them to the wire shape (`context_length`, `is_free`, …).
 */
export function routerModel(body: Record<string, unknown>, status = 200): Response {
  const providers = Array.isArray(body.providers)
    ? (body.providers as Array<Record<string, any>>).map(p => ({
        provider: p.provider,
        status: p.status,
        ...(typeof p.contextLength === 'number' ? { context_length: p.contextLength } : {}),
        ...(typeof p.isFree === 'boolean' ? { is_free: p.isFree } : {}),
        ...(p.pricing ? { pricing: { input: p.pricing.input, output: p.pricing.output } } : {}),
      }))
    : body.providers;
  return jsonResponse({ ...body, providers }, status);
}

/** Activates the Hugging Face backend for the duration of a test file. */
export function useHuggingFaceBackend() {
  const previous = { ...process.env } as Record<string, string | undefined>;
  process.env.HF_TOKEN = 'hf_test_token_0123456789abcdef';
  process.env.AI_BACKEND = 'huggingface';
  process.env.AI_ALLOW_PAID_INFERENCE = 'false';
  process.env.AI_REQUIRE_CONFIRMED_PRICING = 'false';
  process.env.AI_FALLBACK_ENABLED = 'true';
  process.env.AI_MAX_FALLBACK_ATTEMPTS = '4';
  process.env.AI_MAX_RETRIES_PER_MODEL = '0';
  process.env.AI_REQUEST_TIMEOUT_MS = '5000';
  process.env.AI_MODEL_CACHE_TTL_SECONDS = '0';
  process.env.AI_MAX_TEXT_REQUESTS_PER_USER_PER_HOUR = '1000';
  process.env.AI_MAX_IMAGE_REQUESTS_PER_USER_PER_HOUR = '1000';
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  };
}

/**
 * Activates the Agnes AI backend for the duration of a test.
 *
 * With `fallback` (default) a Hugging Face token is configured as well and
 * `AI_BACKEND` stays `auto`, so `agnes` is the active backend with the Hugging
 * Face chain reachable as the fallback — the production configuration this
 * codebase ships.
 */
export function useAgnesBackend(options: { fallback?: boolean } = {}) {
  const previous = { ...process.env } as Record<string, string | undefined>;
  process.env.AGNES_API_KEY = 'agnes_test_key_0123456789abcdef';
  delete process.env.AGNES_BASE_URL;
  delete process.env.AGNES_TEXT_MODEL;
  delete process.env.AGNES_IMAGE_MODEL;
  if (options.fallback === false) {
    delete process.env.HF_TOKEN;
    process.env.AI_BACKEND = 'agnes';
  } else {
    process.env.HF_TOKEN = 'hf_test_token_0123456789abcdef';
    delete process.env.AI_BACKEND;
  }
  process.env.AI_ALLOW_PAID_INFERENCE = 'false';
  process.env.AI_REQUIRE_CONFIRMED_PRICING = 'false';
  process.env.AI_FALLBACK_ENABLED = 'true';
  process.env.AI_MAX_FALLBACK_ATTEMPTS = '4';
  process.env.AI_MAX_RETRIES_PER_MODEL = '0';
  process.env.AI_REQUEST_TIMEOUT_MS = '5000';
  process.env.AI_MODEL_CACHE_TTL_SECONDS = '0';
  process.env.AI_MAX_TEXT_REQUESTS_PER_USER_PER_HOUR = '1000';
  process.env.AI_MAX_IMAGE_REQUESTS_PER_USER_PER_HOUR = '1000';
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  };
}

/** Agnes AI chat-completions response (OpenAI-compatible shape). */
export function agnesChatSuccess(text: string): Response {
  return jsonResponse({
    id: 'chatcmpl_agnes_test',
    object: 'chat.completion',
    model: 'agnes-2.5-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 15, completion_tokens: 9, total_tokens: 24 },
  });
}

/** Agnes AI images/generations response (Base64 output shape). */
export function agnesImageSuccess(b64 = BIG_PNG_BASE64): Response {
  return jsonResponse({
    created: 1_780_000_000,
    data: [{ url: null, b64_json: b64, revised_prompt: null }],
  });
}

/** Handler matching only Agnes AI endpoints on apihub.agnes-ai.com. */
export function agnesHandler(
  decide: (body: any, url: string) => Response | null | Promise<Response | null>,
): MockHandler {
  return (url, init) => {
    if (!url.includes('apihub.agnes-ai.com')) return null;
    const body = safeJson(String(init.body ?? '{}'));
    return decide(body, url);
  };
}

export const spy = vi.fn;

/**
 * Performs one chat-completions call through the module's injected `fetch`.
 * Used by orchestrator tests so attempts really go through the fake transport
 * rather than the network.
 */
export async function chatViaInjected(modelId: string): Promise<string> {
  const { hfChatCompletion } = await import('@/lib/ai/huggingface-client');
  const result = await hfChatCompletion({ modelId, prompt: 'Write a sentence.' });
  if (!result.text) {
    const err = new Error('The model returned no usable text.');
    (err as any).status = 502;
    throw err;
  }
  return result.text;
}
