/**
 * Live provider self-tests.
 *
 * Setting `AGNES_API_KEY` in the hosting dashboard proves only that a variable
 * exists: it does not prove the key is valid, that the deployment answering the
 * request can see it, or that the account is allowed to call the model. This
 * module makes one deliberately tiny, real request and reports what actually
 * happened — model, latency and, on failure, a classified reason.
 *
 * Rules:
 *  - no test ever runs against the network unless it is explicitly requested
 *    (`testAgnesProvider` is only called from the admin route behind a button);
 *  - the API key never appears in the result, its message, or the logs;
 *  - provider error text is truncated and redacted before it leaves here;
 *  - image tests additionally require `AI_ALLOW_LIVE_IMAGE_HEALTH_CHECKS=true`
 *    because they spend credits and are slow.
 */
import 'server-only';
import { agnesChatCompletion, agnesGenerateImage } from './agnes-client';
import { agnesConfigured, aiPolicy } from './config';
import { classifyAiError } from './error-classifier';

export type ProviderTestKind = 'text' | 'image';

export interface ProviderTestResult {
  ok: boolean;
  provider: 'agnes-ai';
  kind: ProviderTestKind;
  model: string;
  endpoint: string;
  /** Wall-clock duration of the test request. */
  latencyMs: number;
  testedAt: string;
  /** Short proof-of-life excerpt of the real answer (text tests only). */
  sample?: string;
  /** Byte length of the generated image (image tests only). */
  imageBytes?: number;
  error?: {
    /** `classifyAiError` category, or `disabled` / `not_configured`. */
    category: string;
    status?: number;
    /** Always safe to display: no key, no provider request dump. */
    message: string;
  };
}

/** A tiny completion: enough to prove the round-trip, cheap enough to repeat. */
const TEST_PROMPT = 'Reply with exactly: NovelForge Agnes AI is online.';

const MAX_SAMPLE_CHARS = 160;

function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
    .replace(/agnes-[A-Za-z0-9_-]{10,}/g, 'agnes-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}

function shortMessage(raw: string): string {
  const cleaned = redact(raw).replace(/\s+/g, ' ').trim();
  return cleaned.length > 240 ? `${cleaned.slice(0, 240)}…` : cleaned;
}

/**
 * Makes one real, minimal Agnes AI request for the given modality and reports
 * the outcome. Never throws for a provider failure — a failed test is a result.
 */
export async function testAgnesProvider(kind: ProviderTestKind = 'text'): Promise<ProviderTestResult> {
  const policy = aiPolicy();
  const base = { provider: 'agnes-ai' as const, kind };
  const testedAt = new Date().toISOString();
  const model = kind === 'image' ? policy.agnesImageModel : policy.agnesTextModel;
  const endpoint =
    kind === 'image' ? `${policy.agnesBaseUrl}/images/generations` : `${policy.agnesBaseUrl}/chat/completions`;
  const started = Date.now();

  if (!agnesConfigured()) {
    return {
      ...base,
      ok: false,
      model,
      endpoint,
      latencyMs: 0,
      testedAt,
      error: {
        category: 'not_configured',
        message:
          'AGNES_API_KEY is not visible to this deployment. Add it in the host (Production scope), then redeploy — environment variables are read when a deployment is built.',
      },
    };
  }

  if (kind === 'image' && !policy.allowLiveImageHealthChecks) {
    return {
      ...base,
      ok: false,
      model,
      endpoint,
      latencyMs: 0,
      testedAt,
      error: {
        category: 'disabled',
        message:
          'Live image tests are disabled because they spend credits. Set AI_ALLOW_LIVE_IMAGE_HEALTH_CHECKS=true to allow an explicit image test.',
      },
    };
  }

  try {
    if (kind === 'image') {
      const image = await agnesGenerateImage({
        prompt: 'A single closed leather-bound book on a plain desk, soft window light, no text.',
        width: 1024,
        height: 1024,
        sizeTier: '1K',
        timeoutMs: Math.max(policy.requestTimeoutMs, 180_000),
      });
      return {
        ...base,
        ok: true,
        model: image.model,
        endpoint,
        latencyMs: image.latencyMs,
        testedAt,
        imageBytes: image.buffer.length,
      };
    }

    const result = await agnesChatCompletion({
      prompt: TEST_PROMPT,
      maxNewTokens: 32,
      temperature: 0,
      timeoutMs: policy.requestTimeoutMs,
    });
    const text = (result.text || '').trim();
    if (!text) {
      return {
        ...base,
        ok: false,
        model: result.model,
        endpoint,
        latencyMs: result.latencyMs,
        testedAt,
        error: {
          category: 'empty_output',
          message: 'Agnes AI answered, but the completion contained no text.',
        },
      };
    }
    return {
      ...base,
      ok: true,
      model: result.model,
      endpoint,
      latencyMs: result.latencyMs,
      testedAt,
      sample: text.slice(0, MAX_SAMPLE_CHARS),
    };
  } catch (err) {
    const info = classifyAiError(err, { modelId: model, task: kind === 'image' ? 'text-to-image' : 'text-generation' });
    return {
      ...base,
      ok: false,
      model,
      endpoint,
      latencyMs: Date.now() - started,
      testedAt,
      error: {
        category: info.category,
        status: info.status,
        message: shortMessage(info.userMessage),
      },
    };
  }
}
