/**
 * Output validation. A "successful" HTTP call is not a successful generation:
 * empty text, a truncated JSON blob or a few bytes of HTML are all failures
 * that must be detected before anything is saved.
 */
import { sniffImageMime } from './huggingface-client';

export interface TextValidationOptions {
  minChars?: number;
  maxChars?: number;
  requireJsonObject?: boolean;
  /** Reject output that echoes the instructions back. */
  rejectPromptEcho?: boolean;
  prompt?: string;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  category?: 'empty_output' | 'malformed_output' | 'invalid_image';
  value?: string;
}

const DEFAULT_MIN_CHARS = 2;

export function validateTextOutput(raw: string | undefined | null, options: TextValidationOptions = {}): ValidationResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, category: 'empty_output', reason: 'The model returned no text.' };
  }
  const text = raw.trim();
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  if (text.length < minChars) {
    return { ok: false, category: 'empty_output', reason: `The model returned only ${text.length} character(s).` };
  }
  if (options.maxChars && text.length > options.maxChars) {
    return { ok: false, category: 'malformed_output', reason: `The model returned ${text.length} characters (limit ${options.maxChars}).` };
  }
  if (options.rejectPromptEcho && options.prompt) {
    const head = text.slice(0, 200).toLowerCase();
    const marker = options.prompt.slice(-120).toLowerCase();
    if (marker.length > 40 && head.includes(marker)) {
      return { ok: false, category: 'malformed_output', reason: 'The model echoed the prompt instead of generating content.' };
    }
  }
  if (options.requireJsonObject) {
    const parsed = extractJsonObject(text);
    if (parsed === null) {
      return { ok: false, category: 'malformed_output', reason: 'The model did not return a JSON object.' };
    }
    return { ok: true, value: parsed };
  }
  return { ok: true, value: text };
}

/** Pulls the first JSON object out of a model response (tolerating fences). */
export function extractJsonObject(raw: string): string | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    const parsed = JSON.parse(candidate);
    return typeof parsed === 'object' && parsed !== null ? candidate : null;
  } catch {
    // Fall back to the outermost balanced object in the string.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    const slice = candidate.slice(start, end + 1);
    try {
      JSON.parse(slice);
      return slice;
    } catch {
      return null;
    }
  }
}

export interface ImageValidationOptions {
  minBytes?: number;
  maxBytes?: number;
  expectedWidth?: number;
  expectedHeight?: number;
}

export function validateImageBuffer(buffer: Buffer | undefined | null, options: ImageValidationOptions = {}): ValidationResult {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, category: 'empty_output', reason: 'The image generation returned no data.' };
  }
  const minBytes = options.minBytes ?? 1_000;
  if (buffer.length < minBytes) {
    return { ok: false, category: 'invalid_image', reason: `The image payload is only ${buffer.length} bytes.` };
  }
  if (options.maxBytes && buffer.length > options.maxBytes) {
    return { ok: false, category: 'invalid_image', reason: `The image payload is larger than ${options.maxBytes} bytes.` };
  }
  if (!sniffImageMime(buffer)) {
    return { ok: false, category: 'invalid_image', reason: 'The response was not a recognised image format (PNG/JPEG/WEBP/GIF).' };
  }
  return { ok: true };
}

/** Removes duplicated paragraphs that models emit when repeating context. */
export function deduplicateParagraphs(text: string): string {
  if (!text) return text;
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    const key = paragraph.toLowerCase().replace(/\s+/g, ' ').slice(0, 240);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(paragraph);
  }
  return out.join('\n\n');
}

/** Rough word count used for progress and target checks. */
export function wordCount(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}
