/**
 * Low-level Hugging Face Inference Providers HTTP client.
 *
 * Deliberately dependency-free: it talks to the documented, currently supported
 * HTTP API with `fetch`, so there is no deprecated-SDK risk and no extra
 * package to keep in sync.
 *
 * Endpoints used (see docs/AI_INFERENCE.md):
 *  - POST {router}/v1/chat/completions        — OpenAI-compatible chat (text)
 *  - POST {router}/v1/images/generations      — OpenAI-compatible images (when supported)
 *  - POST {router}/{provider}/models/{id}     — provider-native task route (images)
 *  - GET  {hub}/api/models/{id}               — repository metadata (gated, license, task)
 *  - GET  {router}/v1/models/{id}             — router catalog (providers, status, pricing)
 *
 * Security: the token is read per request from `huggingFaceToken()` and is
 * never stored on this module, never logged, and never included in any returned
 * value. Error bodies are redacted before they leave this module.
 */
import 'server-only';
import { huggingFaceToken, aiPolicy, type ImageTransport } from './config';
import type { AiErrorCategory } from './types';

export interface HfRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Pin a provider ("hf-inference", "fal-ai", …) or use "auto". */
  provider?: string;
}

export interface HfChatCompletionResult {
  text: string;
  provider?: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs: number;
  /** Provider-reported cost, when the router supplies it. */
  cost?: { amount: number; currency: string; confirmed: boolean };
}

export interface HfImageResult {
  buffer: Buffer;
  mimeType: string;
  provider?: string;
  model: string;
  latencyMs: number;
  width?: number;
  height?: number;
  transport: ImageTransport | 'openai-compatible' | 'task-native';
}

export interface HfHubModelInfo {
  id: string;
  exists: boolean;
  gated?: boolean | string;
  pipelineTag?: string;
  license?: string;
  tags?: string[];
  downloads?: number;
  lastModified?: string;
  inferenceProviderMapping?: Array<{
    provider: string;
    providerId?: string;
    status?: string;
    task?: string;
    adapter?: string;
    adapterWeightsPath?: string;
  }>;
}

export interface HfRouterModelInfo {
  id: string;
  exists: boolean;
  providers?: Array<{
    provider: string;
    status?: string;
    contextLength?: number;
    pricing?: { input?: number; output?: number };
    isFree?: boolean;
    supportsStructuredOutput?: boolean;
  }>;
}

export class HfHttpError extends Error {
  status: number;
  body: string;
  headers?: Headers;
  /**
   * Explicit error category when the client — not the HTTP status — knows what
   * went wrong (e.g. HTTP 200 carrying a payload that is not an image).
   */
  category?: AiErrorCategory;
  constructor(status: number, body: string, headers?: Headers, category?: AiErrorCategory) {
    super(`Hugging Face request failed (${status}): ${body.slice(0, 400)}`);
    this.name = 'HfHttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
    this.category = category;
  }
}

let _fetchImpl: typeof fetch | null = null;
/** Test seam: inject a fake `fetch` so tests never touch the network. */
export function __setFetchForTests(impl: typeof fetch | null) {
  _fetchImpl = impl;
}

function fetchImpl(): typeof fetch {
  return _fetchImpl ?? globalThis.fetch;
}

function redact(text: string): string {
  if (!text) return text;
  return text
    .replace(/hf_[A-Za-z0-9]{10,}/g, 'hf_[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}

function authHeaders(): Record<string, string> {
  const token = huggingFaceToken();
  if (!token) throw new Error('HF_TOKEN is not configured.');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'NovelForge/1.0 (huggingface-inference-providers)',
  };
}

/** Applies a hard deadline (cancellation + timeout) to a fetch call. */
async function timedFetch(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { timeoutMs = aiPolicy().requestTimeoutMs, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = rest.signal as AbortSignal | undefined;
  const onAbort = () => controller.abort();
  externalSignal?.addEventListener?.('abort', onAbort);
  try {
    return await fetchImpl()(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', onAbort);
  }
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return redact(text.slice(0, 2_000));
  } catch {
    return '';
  }
}

/** Model id sent to the router, with an optional `:provider` pin suffix. */
function routedModelId(modelId: string, provider?: string): string {
  const policy = aiPolicy();
  const chosen = provider && provider !== 'auto' ? provider : policy.provider;
  if (!chosen || chosen === 'auto') return modelId;
  return `${modelId}:${chosen}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text generation
// ─────────────────────────────────────────────────────────────────────────────

export interface HfChatRequest extends HfRequestOptions {
  modelId: string;
  systemPrompt?: string;
  prompt: string;
  maxNewTokens?: number;
  temperature?: number;
  topP?: number;
  responseFormat?: 'text' | 'json_object';
}

export async function hfChatCompletion(req: HfChatRequest): Promise<HfChatCompletionResult> {
  const policy = aiPolicy();
  const started = Date.now();
  const messages: Array<{ role: string; content: string }> = [];
  if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });
  messages.push({ role: 'user', content: req.prompt });

  const body: Record<string, unknown> = {
    model: routedModelId(req.modelId, req.provider),
    messages,
    stream: false,
    max_tokens: Math.max(1, Math.min(req.maxNewTokens ?? 2_048, policy.maxOutputTokens)),
    temperature: req.temperature ?? 0.8,
  };
  if (typeof req.topP === 'number') body.top_p = req.topP;
  if (req.responseFormat === 'json_object') body.response_format = { type: 'json_object' };

  const res = await timedFetch(`${policy.routerBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: req.signal,
    timeoutMs: req.timeoutMs,
  });

  if (!res.ok) {
    throw new HfHttpError(res.status, await readErrorBody(res), res.headers);
  }

  const json = (await res.json().catch(() => ({}))) as any;
  const text: string = json?.choices?.[0]?.message?.content ?? '';
  const provider = res.headers.get('x-inference-provider') ?? json?.provider ?? undefined;
  const usage = json?.usage
    ? {
        inputTokens: typeof json.usage.prompt_tokens === 'number' ? json.usage.prompt_tokens : undefined,
        outputTokens: typeof json.usage.completion_tokens === 'number' ? json.usage.completion_tokens : undefined,
      }
    : undefined;

  return {
    text,
    provider,
    model: json?.model ?? req.modelId,
    usage,
    latencyMs: Date.now() - started,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Image generation
// ─────────────────────────────────────────────────────────────────────────────

const IMAGE_MAGIC: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', test: b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', test: b => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { mime: 'image/gif', test: b => b.length > 6 && b.toString('ascii', 0, 6).startsWith('GIF8') },
];

export function sniffImageMime(buffer: Buffer): string | null {
  for (const candidate of IMAGE_MAGIC) {
    if (candidate.test(buffer)) return candidate.mime;
  }
  return null;
}

async function bufferFromImagePayload(json: any): Promise<{ buffer: Buffer; mimeType: string } | null> {
  // OpenAI-compatible: data[0].b64_json (preferred) or data[0].url.
  const first = Array.isArray(json?.data) ? json.data[0] : undefined;
  if (first?.b64_json) {
    const buffer = Buffer.from(String(first.b64_json), 'base64');
    if (buffer.length) return { buffer, mimeType: sniffImageMime(buffer) ?? 'image/png' };
  }
  if (first?.url && typeof first.url === 'string') {
    if (first.url.startsWith('data:')) {
      const comma = first.url.indexOf(',');
      const meta = first.url.slice(0, comma);
      const payload = first.url.slice(comma + 1);
      const mimeType = /data:([^;]+)/.exec(meta)?.[1] || 'image/png';
      const buffer = meta.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
      if (buffer.length) return { buffer, mimeType };
    }
    return await downloadImage(first.url);
  }
  // Provider-native (fal-ai style): { images: [{ url }] }.
  const imageUrl = json?.images?.[0]?.url;
  if (typeof imageUrl === 'string') return await downloadImage(imageUrl);
  if (typeof json?.image === 'string') {
    const buffer = Buffer.from(json.image, 'base64');
    if (buffer.length) return { buffer, mimeType: sniffImageMime(buffer) ?? 'image/png' };
  }
  return null;
}

async function downloadImage(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const res = await timedFetch(url, { method: 'GET', timeoutMs: aiPolicy().requestTimeoutMs });
  if (!res.ok) throw new HfHttpError(res.status, await readErrorBody(res), res.headers);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get('content-type') || sniffImageMime(buffer) || 'image/png';
  if (!mimeType.startsWith('image/')) return null;
  return { buffer, mimeType: mimeType.split(';')[0] };
}

export interface HfImageRequest extends HfRequestOptions {
  modelId: string;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  guidanceScale?: number;
  transport?: ImageTransport;
}

/** Size string used by the OpenAI-compatible images endpoint. */
function sizeString(width?: number, height?: number): string | undefined {
  if (!width || !height) return undefined;
  return `${Math.round(width)}x${Math.round(height)}`;
}

async function generateImageOpenAiCompatible(
  req: HfImageRequest,
  policy: ReturnType<typeof aiPolicy>,
): Promise<HfImageResult> {
  const started = Date.now();
  const body: Record<string, unknown> = {
    model: routedModelId(req.modelId, req.provider),
    prompt: req.prompt,
    n: 1,
    response_format: 'b64_json',
  };
  const size = sizeString(req.width, req.height);
  if (size) body.size = size;
  if (req.negativePrompt) body.negative_prompt = req.negativePrompt;

  const res = await timedFetch(`${policy.routerBaseUrl}/images/generations`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: req.signal,
    timeoutMs: req.timeoutMs,
  });
  if (!res.ok) throw new HfHttpError(res.status, await readErrorBody(res), res.headers);

  const json = await res.json().catch(() => ({}));
  const payload = await bufferFromImagePayload(json);
  if (!payload) {
    throw new HfHttpError(502, 'Image generation returned no image data.', res.headers, 'invalid_image');
  }
  return {
    ...payload,
    provider: res.headers.get('x-inference-provider') ?? undefined,
    model: json?.model ?? req.modelId,
    latencyMs: Date.now() - started,
    width: req.width,
    height: req.height,
    transport: 'openai-compatible',
  };
}

/**
 * Provider-native task route: `POST {router}/{provider}/models/{providerId}`.
 *
 * Body shapes differ per provider, so the two documented shapes are supported:
 * the HF "standard" task shape (`{inputs, parameters}`) and fal.ai's
 * (`{prompt, image_size, num_images}`). Anything else is classified as a
 * provider error and the orchestrator falls back to another model.
 */
async function generateImageTaskNative(req: HfImageRequest, policy: ReturnType<typeof aiPolicy>): Promise<HfImageResult> {
  const started = Date.now();
  const provider = (req.provider && req.provider !== 'auto' ? req.provider : policy.provider === 'auto' ? 'hf-inference' : policy.provider) as string;
  const routerRoot = policy.routerBaseUrl.replace(/\/v\d+$/, '');
  const url = `${routerRoot}/${provider}/models/${encodeURI(req.modelId)}`;

  const isFal = provider === 'fal-ai';
  const body = isFal
    ? {
        prompt: req.prompt,
        ...(req.width && req.height ? { image_size: { width: req.width, height: req.height } } : {}),
        num_images: 1,
        ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
      }
    : {
        inputs: req.prompt,
        parameters: {
          ...(req.width ? { width: req.width } : {}),
          ...(req.height ? { height: req.height } : {}),
          ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
          ...(req.steps ? { num_inference_steps: req.steps } : {}),
          ...(req.guidanceScale ? { guidance_scale: req.guidanceScale } : {}),
        },
      };

  const res = await timedFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: req.signal,
    timeoutMs: req.timeoutMs,
  });
  if (!res.ok) throw new HfHttpError(res.status, await readErrorBody(res), res.headers);

  const contentType = res.headers.get('content-type') || '';
  if (contentType.startsWith('image/')) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      buffer,
      mimeType: contentType.split(';')[0],
      provider,
      model: req.modelId,
      latencyMs: Date.now() - started,
      width: req.width,
      height: req.height,
      transport: 'task-native',
    };
  }

  const json = await res.json().catch(() => ({}));
  const payload = await bufferFromImagePayload(json);
  if (!payload) throw new HfHttpError(502, 'Image generation returned no image data.', res.headers);
  return {
    ...payload,
    provider,
    model: req.modelId,
    latencyMs: Date.now() - started,
    width: req.width,
    height: req.height,
    transport: 'task-native',
  };
}

/** Generates one image, trying the configured transports in order. */
export async function hfGenerateImage(req: HfImageRequest): Promise<HfImageResult> {
  const policy = aiPolicy();
  const requested = req.transport ?? policy.imageTransport;
  const order: Array<'openai-compatible' | 'task-native'> =
    requested === 'openai-compatible'
      ? ['openai-compatible']
      : requested === 'task-native'
        ? ['task-native']
        : ['openai-compatible', 'task-native'];

  let lastError: unknown;
  for (const transport of order) {
    try {
      return transport === 'openai-compatible'
        ? await generateImageOpenAiCompatible(req, policy)
        : await generateImageTaskNative(req, policy);
    } catch (err) {
      lastError = err;
      // A 404 on the OpenAI-compatible route means the router does not expose
      // images there — try the native route instead of failing the model.
      const status = (err as HfHttpError)?.status;
      if (!(status === 404 || status === 400 || status === 405 || status === 501)) break;
    }
  }
  throw lastError ?? new Error('Image generation failed.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata (verification)
// ─────────────────────────────────────────────────────────────────────────────

/** Repository metadata from the Hub API (`gated`, license, pipeline tag, mapping). */
export async function hfModelInfo(modelId: string, options: HfRequestOptions = {}): Promise<HfHubModelInfo> {
  const policy = aiPolicy();
  const url = `${policy.hubApiBaseUrl}/models/${encodeURI(modelId)}?expand[]=inferenceProviderMapping&expand[]=cardData&expand[]=pipeline_tag&expand[]=gated&expand[]=tags&expand[]=lastModified&expand[]=downloads`;
  const res = await timedFetch(url, {
    method: 'GET',
    headers: { ...authHeaders() },
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 20_000,
  });

  if (res.status === 404) return { id: modelId, exists: false };
  if (res.status === 401 || res.status === 403) {
    // The repository exists but this token may not read it: report as gated
    // rather than claiming the repository is missing.
    return { id: modelId, exists: true, gated: 'access-restricted' };
  }
  if (!res.ok) throw new HfHttpError(res.status, await readErrorBody(res), res.headers);

  const json = (await res.json().catch(() => ({}))) as any;
  const mappingRaw = json?.inferenceProviderMapping;
  let mapping: HfHubModelInfo['inferenceProviderMapping'];
  if (Array.isArray(mappingRaw)) {
    mapping = mappingRaw.map((entry: any) => ({
      provider: entry?.provider ?? entry?.name,
      providerId: entry?.providerId,
      status: entry?.status,
      task: entry?.task,
      adapter: entry?.adapter,
      adapterWeightsPath: entry?.adapterWeightsPath,
    }));
  } else if (mappingRaw && typeof mappingRaw === 'object') {
    mapping = Object.entries(mappingRaw as Record<string, any>).map(([provider, entry]) => ({
      provider,
      providerId: entry?.providerId,
      status: entry?.status,
      task: entry?.task,
      adapter: entry?.adapter,
      adapterWeightsPath: entry?.adapterWeightsPath,
    }));
  }

  return {
    id: json?.id ?? modelId,
    exists: true,
    gated: json?.gated === false ? false : json?.gated ?? undefined,
    pipelineTag: json?.pipeline_tag ?? json?.pipelineTag ?? undefined,
    license: json?.cardData?.license ?? json?.cardData?.licence ?? json?.license ?? undefined,
    tags: Array.isArray(json?.tags) ? json.tags : undefined,
    downloads: typeof json?.downloads === 'number' ? json.downloads : undefined,
    lastModified: json?.lastModified ?? undefined,
    inferenceProviderMapping: mapping,
  };
}

/** Router catalog entry: which providers serve this model, with status/pricing. */
export async function hfRouterModelInfo(modelId: string, options: HfRequestOptions = {}): Promise<HfRouterModelInfo> {
  const policy = aiPolicy();
  const url = `${policy.routerBaseUrl}/models/${encodeURI(modelId)}`;
  const res = await timedFetch(url, {
    method: 'GET',
    headers: authHeaders(),
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 20_000,
  });
  if (res.status === 404) return { id: modelId, exists: false };
  if (!res.ok) throw new HfHttpError(res.status, await readErrorBody(res), res.headers);
  const json = (await res.json().catch(() => ({}))) as any;
  return {
    id: json?.id ?? modelId,
    exists: true,
    providers: Array.isArray(json?.providers)
      ? json.providers.map((p: any) => ({
          provider: p?.provider,
          status: p?.status,
          contextLength: typeof p?.context_length === 'number' ? p.context_length : undefined,
          pricing: p?.pricing ? { input: p.pricing.input, output: p.pricing.output } : undefined,
          isFree: typeof p?.is_free === 'boolean' ? p.is_free : undefined,
          supportsStructuredOutput: typeof p?.supports_structured_output === 'boolean' ? p.supports_structured_output : undefined,
        }))
      : undefined,
  };
}
