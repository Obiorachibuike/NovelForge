/**
 * Low-level Agnes AI HTTP client (https://www.agnes-ai.com/en/docs).
 *
 * Agnes AI is NovelForge's *primary* text and image provider. The API is
 * OpenAI-compatible, but like the Hugging Face client this module talks to the
 * documented HTTP surface with `fetch` — no extra SDK, no deprecated-SDK risk.
 *
 * Endpoints used:
 *  - POST {base}/chat/completions      — OpenAI-compatible chat (text)
 *      · model `agnes-2.5-flash` (configurable via AGNES_TEXT_MODEL)
 *  - POST {base}/images/generations    — image generation & editing
 *      · model `agnes-image-2.5-flash` (configurable via AGNES_IMAGE_MODEL)
 *      · tier-based `size` (`1K`…`4K`) + `ratio` (`1:1`, `3:4`, `16:9`, …)
 *      · Base64 output via `return_base64` / `extra_body.response_format`
 *      · image-to-image via `extra_body.image` (URLs or data URIs)
 *
 * Security: the API key is read per request from `agnesToken()` and is never
 * stored on this module, never logged, and never included in any returned
 * value. Error bodies are redacted before they leave this module.
 */
import 'server-only';
import { agnesToken, aiPolicy } from './config';
import type { AiErrorCategory } from './types';

export class AgnesHttpError extends Error {
  status: number;
  body: string;
  headers?: Headers;
  /** Explicit category when the client — not the status — knows the problem. */
  category?: AiErrorCategory;
  constructor(status: number, body: string, headers?: Headers, category?: AiErrorCategory) {
    super(`Agnes AI request failed (${status}): ${body.slice(0, 400)}`);
    this.name = 'AgnesHttpError';
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
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
    .replace(/agnes-[A-Za-z0-9_-]{10,}/g, 'agnes-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}

function authHeaders(): Record<string, string> {
  const token = agnesToken();
  if (!token) throw new Error('AGNES_API_KEY is not configured.');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'NovelForge/1.0 (agnes-ai)',
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

// ─────────────────────────────────────────────────────────────────────────────
// Text generation (chat completions)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgnesChatRequest {
  systemPrompt?: string;
  prompt?: string;
  /** Full message array; when omitted, built from systemPrompt + prompt. */
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  maxNewTokens?: number;
  temperature?: number;
  topP?: number;
  responseFormat?: 'text' | 'json_object';
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AgnesChatResult {
  text: string;
  model: string;
  provider: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs: number;
}

export async function agnesChatCompletion(req: AgnesChatRequest): Promise<AgnesChatResult> {
  const policy = aiPolicy();
  const started = Date.now();
  const model = req.model || policy.agnesTextModel;

  if (!req.messages && !req.prompt) {
    throw new Error('Agnes AI chat request requires a prompt or messages.');
  }
  const messages = req.messages
    ? req.messages.map(m => ({ role: m.role, content: m.content }))
    : [
        ...(req.systemPrompt ? [{ role: 'system', content: req.systemPrompt }] : []),
        { role: 'user', content: req.prompt },
      ];

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    max_tokens: Math.max(1, Math.min(req.maxNewTokens ?? 2_048, policy.maxOutputTokens)),
    temperature: req.temperature ?? 0.8,
  };
  if (typeof req.topP === 'number') body.top_p = req.topP;
  if (req.responseFormat === 'json_object') body.response_format = { type: 'json_object' };

  const res = await timedFetch(`${policy.agnesBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: req.signal,
    timeoutMs: req.timeoutMs,
  });

  if (!res.ok) {
    throw new AgnesHttpError(res.status, await readErrorBody(res), res.headers);
  }

  const json = (await res.json().catch(() => ({}))) as any;
  const text: string = json?.choices?.[0]?.message?.content ?? '';
  const usage = json?.usage
    ? {
        inputTokens: typeof json.usage.prompt_tokens === 'number' ? json.usage.prompt_tokens : undefined,
        outputTokens: typeof json.usage.completion_tokens === 'number' ? json.usage.completion_tokens : undefined,
      }
    : undefined;

  return {
    text,
    model: json?.model ?? model,
    provider: 'agnes-ai',
    usage,
    latencyMs: Date.now() - started,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Image generation (images/generations)
// ─────────────────────────────────────────────────────────────────────────────

/** Aspect ratios documented for `agnes-image-2.5-flash` tier-based sizes. */
export const AGNES_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'] as const;
export type AgnesRatio = (typeof AGNES_RATIOS)[number];
export type AgnesSizeTier = '1K' | '2K' | '3K' | '4K';

/** Documented 1K-tier output dimensions per ratio (width × height). */
const RATIO_ASPECTS: Record<AgnesRatio, { aspect: number; width1k: number; height1k: number }> = {
  '1:1': { aspect: 1, width1k: 1024, height1k: 1024 },
  '3:4': { aspect: 3 / 4, width1k: 864, height1k: 1152 },
  '4:3': { aspect: 4 / 3, width1k: 1152, height1k: 864 },
  '16:9': { aspect: 16 / 9, width1k: 1312, height1k: 736 },
  '9:16': { aspect: 9 / 16, width1k: 736, height1k: 1312 },
  '2:3': { aspect: 2 / 3, width1k: 832, height1k: 1248 },
  '3:2': { aspect: 3 / 2, width1k: 1248, height1k: 832 },
  '21:9': { aspect: 21 / 9, width1k: 1568, height1k: 672 },
};

/** Tier multipliers: every documented tier scales the 1K reference dimensions. */
const TIER_FACTOR: Record<AgnesSizeTier, number> = { '1K': 1, '2K': 2, '3K': 3, '4K': 4 };

/**
 * Maps requested pixel dimensions onto the closest documented `ratio`
 * (and its per-tier dimensions). Agnes normalises unsupported exact sizes
 * anyway; requesting the documented tier + ratio keeps the output predictable.
 */
export function nearestAgnesSize(
  width: number,
  height: number,
  tier: AgnesSizeTier = '1K',
): { size: AgnesSizeTier; ratio: AgnesRatio; width: number; height: number } {
  const aspect = height > 0 ? width / height : 1;
  let best: AgnesRatio = '1:1';
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const ratio of AGNES_RATIOS) {
    const diff = Math.abs(Math.log(aspect / RATIO_ASPECTS[ratio].aspect));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = ratio;
    }
  }
  const ref = RATIO_ASPECTS[best];
  const factor = TIER_FACTOR[tier] ?? 1;
  return { size: tier, ratio: best, width: ref.width1k * factor, height: ref.height1k * factor };
}

export interface AgnesImageRequest {
  prompt: string;
  /** Requested pixel size; mapped to the nearest documented tier + ratio. */
  width?: number;
  height?: number;
  /** Output tier (`1K`…`4K`); default `1K`. */
  sizeTier?: AgnesSizeTier;
  model?: string;
  /** Reference images (public URLs or data URIs) for image-to-image. */
  images?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AgnesImageResult {
  buffer: Buffer;
  mimeType: string;
  model: string;
  provider: string;
  /** Output dimensions (documented tier/ratio size, or decoded PNG size). */
  width?: number;
  height?: number;
  latencyMs: number;
}

/** Decodes a PNG IHDR header for the real output dimensions (best effort). */
export function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (!(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length > 6 && buffer.toString('ascii', 0, 6).startsWith('GIF8')) return 'image/gif';
  return null;
}

async function downloadImage(url: string, signal?: AbortSignal): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await timedFetch(url, { method: 'GET', signal, timeoutMs: 60_000 });
  if (!res.ok) {
    throw new AgnesHttpError(res.status, `Generated image download failed (${url.slice(0, 120)})`, res.headers);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) {
    const err = new AgnesHttpError(502, 'Generated image download returned an empty body.');
    err.category = 'empty_output';
    throw err;
  }
  const declared = res.headers.get('content-type')?.split(';')[0];
  return { buffer, mimeType: sniffImageMime(buffer) ?? (declared?.startsWith('image/') ? declared : 'image/png') };
}

/**
 * Generates one image with `agnes-image-2.5-flash`.
 *
 * Base64 output is requested (both mechanisms the docs describe are set, so
 * either accepted shape works) and the payload is decoded locally — no
 * second network round-trip for a hosted URL. A URL response is still
 * supported and downloaded when the service returns one.
 */
export async function agnesGenerateImage(req: AgnesImageRequest): Promise<AgnesImageResult> {
  const policy = aiPolicy();
  const started = Date.now();
  const model = req.model || policy.agnesImageModel;
  const sizeTier = req.sizeTier ?? '1K';
  const mapped = nearestAgnesSize(req.width ?? 832, req.height ?? 1248, sizeTier);

  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    size: mapped.size,
    ratio: mapped.ratio,
    return_base64: true,
    extra_body: { response_format: 'b64_json' },
  };
  if (req.images?.length) {
    (body.extra_body as Record<string, unknown>).image = req.images;
  }

  const res = await timedFetch(`${policy.agnesBaseUrl}/images/generations`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: req.signal,
    timeoutMs: req.timeoutMs ?? Math.max(policy.requestTimeoutMs, 180_000),
  });

  if (!res.ok) {
    throw new AgnesHttpError(res.status, await readErrorBody(res), res.headers);
  }

  const json = (await res.json().catch(() => ({}))) as any;
  const first = Array.isArray(json?.data) ? json.data[0] : undefined;

  let buffer: Buffer | null = null;
  let mimeType: string | null = null;
  if (first?.b64_json) {
    buffer = Buffer.from(String(first.b64_json), 'base64');
    mimeType = sniffImageMime(buffer);
  } else if (typeof first?.url === 'string' && first.url) {
    if (first.url.startsWith('data:')) {
      const comma = first.url.indexOf(',');
      const meta = first.url.slice(0, comma);
      const payload = first.url.slice(comma + 1);
      mimeType = /data:([^;]+)/.exec(meta)?.[1] ?? 'image/png';
      buffer = meta.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
      mimeType = sniffImageMime(buffer) ?? mimeType;
    } else {
      const downloaded = await downloadImage(first.url, req.signal);
      buffer = downloaded.buffer;
      mimeType = downloaded.mimeType;
    }
  }

  if (!buffer || !buffer.length) {
    const err = new AgnesHttpError(502, 'Agnes AI returned a response without usable image data.');
    err.category = 'empty_output';
    throw err;
  }

  const dims = pngDimensions(buffer);
  return {
    buffer,
    mimeType: mimeType ?? 'image/png',
    model: json?.model ?? model,
    provider: 'agnes-ai',
    width: dims?.width ?? mapped.width,
    height: dims?.height ?? mapped.height,
    latencyMs: Date.now() - started,
  };
}
