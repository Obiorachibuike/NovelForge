import 'server-only';

/**
 * Published list prices in USD per 1,000 tokens (and per image), used to
 * estimate spend. These are estimates for budgeting only — the provider's
 * invoice remains authoritative. Values are overridable per deployment with
 * `AI_PRICE_<UPPER_SNAKE_MODEL>_PROMPT` / `..._COMPLETION` environment variables.
 */
export interface ModelPrice {
  promptPer1k: number;
  completionPer1k: number;
}

const DEFAULT_PRICE: ModelPrice = { promptPer1k: 0.0025, completionPer1k: 0.01 };

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-4o': { promptPer1k: 0.0025, completionPer1k: 0.01 },
  'gpt-4o-mini': { promptPer1k: 0.00015, completionPer1k: 0.0006 },
  'gpt-4.1': { promptPer1k: 0.002, completionPer1k: 0.008 },
  'gpt-4.1-mini': { promptPer1k: 0.0004, completionPer1k: 0.0016 },
  'gpt-4.1-nano': { promptPer1k: 0.0001, completionPer1k: 0.0004 },
  'gpt-4-turbo': { promptPer1k: 0.01, completionPer1k: 0.03 },
  'o3-mini': { promptPer1k: 0.0011, completionPer1k: 0.0044 },
  'text-embedding-3-small': { promptPer1k: 0.00002, completionPer1k: 0 },
  'text-embedding-3-large': { promptPer1k: 0.00013, completionPer1k: 0 },
  'text-embedding-ada-002': { promptPer1k: 0.0001, completionPer1k: 0 },
};

/** Estimated USD per generated image, by model. */
export const IMAGE_PRICES: Record<string, number> = {
  'gpt-image-1': 0.04,
  'gpt-image-1-mini': 0.011,
  'dall-e-3': 0.04,
  'dall-e-2': 0.018,
};

function envPrice(model: string, kind: 'PROMPT' | 'COMPLETION'): number | null {
  const key = `AI_PRICE_${model.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${kind}`;
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : null;
}

/** Longest-prefix match so `gpt-4o-mini-2024-07-18` resolves to `gpt-4o-mini`. */
export function priceFor(model: string): ModelPrice {
  const normalized = (model || '').toLowerCase();
  let best: string | null = null;
  for (const key of Object.keys(MODEL_PRICES)) {
    if (normalized === key || normalized.startsWith(`${key}-`) || normalized.startsWith(key)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  const base = best ? MODEL_PRICES[best] : DEFAULT_PRICE;
  return {
    promptPer1k: envPrice(model, 'PROMPT') ?? base.promptPer1k,
    completionPer1k: envPrice(model, 'COMPLETION') ?? base.completionPer1k,
  };
}

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const price = priceFor(model);
  const cost = (Math.max(0, promptTokens) / 1000) * price.promptPer1k
    + (Math.max(0, completionTokens) / 1000) * price.completionPer1k;
  return Math.round(cost * 1e6) / 1e6;
}

export function estimateImageCostUsd(model: string, images = 1): number {
  const normalized = (model || '').toLowerCase();
  const key = Object.keys(IMAGE_PRICES).find(k => normalized === k || normalized.startsWith(k));
  const unit = key ? IMAGE_PRICES[key] : 0.04;
  return Math.round(unit * images * 1e6) / 1e6;
}
