import { z, type ZodType, type ZodTypeDef } from 'zod';
import { getOpenAI, aiConfig, recordUsage } from './provider';
import type { ChatMessage } from '@/types';
import 'server-only';

/** Chat completion that returns plain text. */
export async function generateText(input: {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  userId: string;
  novelId?: string;
  taskType: string;
}): Promise<string> {
  const client = getOpenAI();
  const model = input.model || aiConfig.textModel;
  if (!client) {
    return demoTextResponse(input.messages);
  }
  const resp = await client.chat.completions.create({
    model,
    messages: input.messages,
    temperature: input.temperature ?? 0.8,
    max_tokens: input.maxTokens ?? 2048,
  });
  const content = resp.choices[0]?.message?.content || '';
  const usage = resp.usage;
  if (usage) {
    await recordUsage({
      userId: input.userId, novelId: input.novelId, taskType: input.taskType, model,
      promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
    });
  }
  return content;
}

/** Chat completion with structured JSON output enforced by Zod. */
export async function generateStructured<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  input: {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    userId: string; novelId?: string; taskType: string;
    fallback: T; // used in demo mode OR when parsing fails
    retries?: number;
  }
): Promise<T> {
  const client = getOpenAI();
  const model = input.model || aiConfig.structuredModel;
  if (!client) return input.fallback;

  const systemInject: ChatMessage = {
    role: 'system',
    content: 'You MUST respond only with valid JSON that matches the schema requested. No prose, no markdown, no code fences.',
  };

  for (let attempt = 0; attempt < (input.retries ?? 2); attempt++) {
    const resp = await client.chat.completions.create({
      model,
      messages: [systemInject, ...input.messages],
      temperature: input.temperature ?? 0.4,
      response_format: { type: 'json_object' },
    });
    const raw = resp.choices[0]?.message?.content || '{}';
    const usage = resp.usage;
    if (usage) {
      await recordUsage({
        userId: input.userId, novelId: input.novelId, taskType: input.taskType, model,
        promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
      });
    }
    try {
      const parsed = JSON.parse(extractJson(raw));
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
      console.warn('structured output parse failed:', result.error.errors, raw.slice(0,400));
    } catch (e) {
      console.warn('structured output JSON parse failed:', e, raw.slice(0,400));
    }
  }
  return input.fallback;
}

/** Streaming response (returns async iterator). For client-side progress. */
export async function* streamText(input: {
  messages: ChatMessage[]; model?: string; temperature?: number;
  userId: string; novelId?: string; taskType: string;
}): AsyncGenerator<string> {
  const client = getOpenAI();
  const model = input.model || aiConfig.textModel;
  if (!client) {
    const txt = demoTextResponse(input.messages);
    // Stream in small chunks
    for (let i=0;i<txt.length;i+=24) { yield txt.slice(i,i+24); await new Promise(r=>setTimeout(r,10)); }
    return;
  }
  const stream = await client.chat.completions.create({
    model, messages: input.messages, temperature: input.temperature ?? 0.8, stream: true,
  });
  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

function extractJson(raw: string) {
  // Strip common code-fence wrapping
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenced) return fenced[1].trim();
  return raw.trim();
}

/** Deterministic demo response so developers can see UI flow without API keys. */
function demoTextResponse(messages: ChatMessage[]): string {
  const last = messages[messages.length-1]?.content || '';
  // Provide a small novel chapter snippet when it looks like a chapter generation prompt
  if (/chapter/i.test(last) && /word/i.test(last)) {
    return [
      'The rain had stopped by the time she reached the bridge, but the stones still glistened like old wounds.',
      'She pulled her collar higher and counted the arches—seven, just as the letter had said.',
      'Somewhere behind her, a door creaked open in a building that should have been empty for years.',
      '"You took your time," a voice said from the shadow of the pier.',
      'She did not turn. Not yet. Instead she watched the water drag a crumpled leaf toward the sea, and for the first time in twelve years she allowed herself to believe she might not have to do this alone.',
    ].join('\n\n');
  }
  if (/outline|chapter/i.test(last)) {
    return 'The hero crosses the threshold into the unknown. Allies appear, questions multiply, and the first thread of the central conflict is pulled.';
  }
  return 'The story deepens here. A new detail emerges, small but vital, that will echo in the chapters ahead.';
}
