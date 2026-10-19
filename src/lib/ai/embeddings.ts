import { getOpenAI, aiConfig, recordUsage, withTimeout, assertAiBudget, estimateCostUsd } from './provider';
import 'server-only';

const MAX_EMBEDDING_CACHE = 256;
const embeddingCache = new Map<string, number[]>();

export function clearEmbeddingCacheForTests() {
  embeddingCache.clear();
}

/**
 * Produce an embedding vector for the given text. Falls back to a cheap
 * deterministic hash-based vector when no API key is configured, so that the
 * story-memory retrieval still returns *something* in demo mode.
 */
export async function embed(text: string, userId: string, novelId?: string): Promise<number[]> {
  const trimmed = (text || '').slice(0, 8000);
  const client = getOpenAI();
  if (!client) return stubEmbedding(trimmed);

  const cacheKey = `${aiConfig.embeddingModel}:${trimmed}`;
  const cached = embeddingCache.get(cacheKey);
  if (cached) return cached;

  const estTokens = Math.ceil(trimmed.length / 4);
  assertAiBudget(userId, estTokens);
  const estimatedCostBeforeUsd = estimateCostUsd(aiConfig.embeddingModel, estTokens, 0);

  const resp = await withTimeout(
    client.embeddings.create({
      model: aiConfig.embeddingModel,
      input: trimmed,
    }, { timeout: aiConfig.timeoutMs }),
    aiConfig.timeoutMs,
    'embedding generation',
  );
  const vec = resp.data[0].embedding;
  const usage = resp.usage;
  if (usage) {
    recordUsage({
      userId,
      novelId,
      taskType: 'embedding',
      model: aiConfig.embeddingModel,
      promptTokens: usage.prompt_tokens,
      completionTokens: 0,
      estimatedCostBeforeUsd,
      source: 'openai',
    });
  }
  if (embeddingCache.size >= MAX_EMBEDDING_CACHE) {
    const oldest = embeddingCache.keys().next().value;
    if (oldest) embeddingCache.delete(oldest);
  }
  embeddingCache.set(cacheKey, vec);
  return vec;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i=0;i<a.length;i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

export function serialize(vec: number[]): string {
  return JSON.stringify(vec);
}

export function deserialize(raw: string | null): number[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

/** Very small (32-dim) deterministic stub vector for demo mode. */
function stubEmbedding(text: string): number[] {
  const vec = new Array(32).fill(0);
  let h = 2166136261;
  for (let i=0; i<text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  for (let i=0; i<32; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    vec[i] = ((h >>> 0) % 1000) / 1000 - 0.5;
  }
  // normalize
  const mag = Math.sqrt(vec.reduce((s,v)=>s+v*v,0)) || 1;
  return vec.map(v => v/mag);
}
