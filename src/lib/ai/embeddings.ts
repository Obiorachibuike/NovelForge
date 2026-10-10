import { getOpenAI, aiConfig, recordUsage } from './provider';
import 'server-only';

/**
 * Produce an embedding vector for the given text. Falls back to a cheap
 * deterministic hash-based vector when no API key is configured, so that the
 * story-memory retrieval still returns *something* in demo mode.
 */
export async function embed(text: string, userId: string, novelId?: string): Promise<number[]> {
  const client = getOpenAI();
  if (!client) return stubEmbedding(text);
  const resp = await client.embeddings.create({
    model: aiConfig.embeddingModel,
    input: text.slice(0, 8000),
  });
  const vec = resp.data[0].embedding;
  const usage = resp.usage;
  if (usage) {
    await recordUsage({
      userId, novelId, taskType: 'embedding', model: aiConfig.embeddingModel,
      promptTokens: usage.prompt_tokens, completionTokens: 0,
    });
  }
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
