import OpenAI from 'openai';
import 'server-only';

let _client: OpenAI | null = null;

/** Returns the OpenAI client, or null when no key is configured (demo mode). */
export function getOpenAI(): OpenAI | null {
  if (_client) return _client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  _client = new OpenAI({ apiKey: key });
  return _client;
}

export const aiConfig = {
  textModel: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
  structuredModel: process.env.OPENAI_STRUCTURED_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
  imageModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  demoMode: !process.env.OPENAI_API_KEY || process.env.AI_DEMO_MODE === 'true',
};

export type StreamEventHandler = (chunk: string) => void;

/**
 * Log a single AI usage record. Called from AI helpers after successful requests.
 */
export async function recordUsage(input: {
  userId: string; novelId?: string; taskType: string; provider?: string;
  model: string; promptTokens: number; completionTokens: number;
}) {
  try {
    const { getDb } = await import('@/lib/db');
    const { nanoid } = await import('nanoid');
    const db = getDb();
    // crude pricing in USD per 1k tokens for default models.
    const pricePrompt = /gpt-4o/i.test(input.model) ? 0.0025 : 0.00015;
    const priceCompletion = /gpt-4o/i.test(input.model) ? 0.01 : 0.0006;
    const cost = (input.promptTokens / 1000) * pricePrompt + (input.completionTokens / 1000) * priceCompletion;
    db.prepare(`INSERT INTO ai_usage (id,userId,novelId,taskType,provider,model,promptTokens,completionTokens,totalTokens,estimatedCostUsd,createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      nanoid(), input.userId, input.novelId || null, input.taskType,
      input.provider || 'openai', input.model, input.promptTokens, input.completionTokens,
      input.promptTokens + input.completionTokens, cost, new Date().toISOString(),
    );
  } catch (err) {
    console.warn('recordUsage failed', err);
  }
}
