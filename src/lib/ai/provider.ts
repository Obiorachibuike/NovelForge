import OpenAI from 'openai';
import 'server-only';

let _client: OpenAI | null = null;
let _clientKey: string | null = null;

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/**
 * Provider configuration.
 *
 * Demo mode is explicit and consistent: it is on when no API key is present
 * **or** when `AI_DEMO_MODE=true`. Every AI helper branches on `demoMode`, so
 * `OPENAI_API_KEY=… AI_DEMO_MODE=true` performs no paid calls anywhere (text,
 * structured output, embeddings or images) instead of the previous behaviour
 * where only image generation honoured the flag.
 */
export const aiConfig = {
  get textModel() { return process.env.OPENAI_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini'; },
  get structuredModel() { return process.env.OPENAI_STRUCTURED_MODEL || process.env.OPENAI_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini'; },
  get imageModel() { return process.env.OPENAI_IMAGE_MODEL || process.env.IMAGE_GENERATION_MODEL || 'gpt-image-1'; },
  get embeddingModel() { return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'; },
  get timeoutMs() { return envInt('AI_TIMEOUT_MS', 90_000); },
  get maxRetries() { return envInt('AI_MAX_RETRIES', 2); },
  get hasApiKey() { return !!process.env.OPENAI_API_KEY; },
  get demoMode() { return this.forcedDemo || !this.hasApiKey; },
  get forcedDemo() { return process.env.AI_DEMO_MODE === 'true'; },
  get providerName() { return this.demoMode ? 'demo' : 'openai'; },
};

/**
 * Returns the OpenAI client, or null when running in demo mode.
 *
 * The client is created with a request timeout and a bounded retry count so a
 * hung or rate-limited upstream cannot hold a worker/job open indefinitely.
 */
export function getOpenAI(): OpenAI | null {
  if (aiConfig.demoMode) return null;
  const key = process.env.OPENAI_API_KEY!;
  if (_client && _clientKey === key) return _client;
  _client = new OpenAI({
    apiKey: key,
    timeout: aiConfig.timeoutMs,
    maxRetries: aiConfig.maxRetries,
  });
  _clientKey = key;
  return _client;
}

/** Test seam: drops the memoised client so env changes take effect. */
export function resetOpenAIForTests() {
  _client = null;
  _clientKey = null;
}

export { estimateCostUsd, estimateImageCostUsd, estimateOperationCost, priceFor } from './pricing';
export { recordUsage, recordImageUsage, assertAiBudget, checkAiBudget, usageSummary, novelUsageSummary, getAiBudget, clampCompletionTokens } from './usage';

/** Resolves a promise or rejects after `ms`, so a stuck upstream cannot hang a job. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'AI request'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
