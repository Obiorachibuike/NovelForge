import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { freshDatabase, seedUser, seedNovel, db } from '../helpers/db';
import {
  assertAiBudget, checkAiBudget, recordUsage, recordImageUsage, usageSummary, getAiBudget, clampCompletionTokens,
} from '@/lib/ai/usage';
import { estimateCostUsd, estimateImageCostUsd } from '@/lib/ai/pricing';
import { aiConfig, withTimeout, resetOpenAIForTests } from '@/lib/ai/provider';
import { generateTextDetailed, generateStructuredDetailed } from '@/lib/ai/text-generation';
import { z } from 'zod';

let user: { id: string; email: string; name: string };
let novel: { id: string; userId: string };

const ENV = { ...process.env };
beforeEach(() => {
  freshDatabase();
  user = seedUser();
  novel = seedNovel(user.id);
  process.env = { ...ENV };
});
afterEach(() => { process.env = { ...ENV }; resetOpenAIForTests(); });

describe('provenance and demo mode', () => {
  it('demo mode needs no API key and never claims to be a provider response', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_DEMO_MODE;
    expect(aiConfig.demoMode).toBe(true);

    const result = await generateTextDetailed({
      messages: [{ role: 'user', content: 'continue the chapter' }],
      userId: user.id, novelId: novel.id, taskType: 'test',
    });
    expect(result.meta.source).toBe('demo');
    expect(result.meta.usedFallback).toBe(false);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('AI_DEMO_MODE=true suppresses paid calls even with a key present', () => {
    process.env.OPENAI_API_KEY = 'sk-present-but-unused';
    process.env.AI_DEMO_MODE = 'true';
    expect(aiConfig.demoMode).toBe(true);
    expect(aiConfig.providerName).toBe('demo');
  });

  it('structured generation returns the caller-supplied fallback in demo mode', async () => {
    process.env.AI_DEMO_MODE = 'true';
    const schema = z.object({ title: z.string(), beats: z.array(z.string()).default([]) });
    const fallback = { title: 'Outline stub', beats: ['beat one'] };
    const { data, meta } = await generateStructuredDetailed(schema, {
      messages: [{ role: 'user', content: 'outline' }],
      userId: user.id, novelId: novel.id, taskType: 'test-structured', fallback,
    });
    expect(meta.source).toBe('demo');
    expect(data).toEqual(fallback);
  });
});

describe('cost tracking', () => {
  it('records tokens, model, task and an estimated cost for real provider calls', () => {
    recordUsage({
      userId: user.id, novelId: novel.id, taskType: 'chapter', model: 'gpt-4o-mini',
      promptTokens: 1200, completionTokens: 800, source: 'openai',
    });
    const row = db().prepare('SELECT * FROM ai_usage WHERE userId=?').get(user.id) as any;
    expect(row.totalTokens).toBe(2000);
    expect(row.taskType).toBe('chapter');
    expect(row.model).toBe('gpt-4o-mini');
    expect(row.estimatedCostUsd).toBeCloseTo(estimateCostUsd('gpt-4o-mini', 1200, 800), 8);
    expect(row.estimatedCostUsd).toBeGreaterThan(0);

    const summary = usageSummary(user.id, 24);
    expect(summary.requests).toBe(1);
    expect(summary.totalTokens).toBe(2000);
    expect(summary.byTask[0]).toMatchObject({ taskType: 'chapter', model: 'gpt-4o-mini', requests: 1 });
    expect(summary.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('records demo/stub usage at zero cost so it cannot inflate spend', () => {
    recordUsage({
      userId: user.id, novelId: novel.id, taskType: 'chapter', model: 'gpt-4o-mini',
      promptTokens: 0, completionTokens: 0, source: 'demo',
    });
    recordImageUsage({ userId: user.id, novelId: novel.id, model: 'gpt-image-1', images: 1, source: 'openai' });
    const rows = db().prepare('SELECT taskType, estimatedCostUsd, source FROM ai_usage ORDER BY taskType').all() as any[];
    expect(rows.find(r => r.taskType === 'chapter')!.estimatedCostUsd).toBe(0);
    const image = rows.find(r => r.taskType === 'cover')!;
    expect(image.estimatedCostUsd).toBeCloseTo(estimateImageCostUsd('gpt-image-1', 1), 8);
  });

  it('summaries are scoped to one user', () => {
    const other = seedUser({ name: 'Other' });
    recordUsage({ userId: user.id, taskType: 'chapter', model: 'gpt-4o-mini', promptTokens: 10, completionTokens: 5, source: 'openai' });
    recordUsage({ userId: other.id, taskType: 'chapter', model: 'gpt-4o-mini', promptTokens: 900, completionTokens: 500, source: 'openai' });
    expect(usageSummary(user.id, 24).totalTokens).toBe(15);
    expect(usageSummary(other.id, 24).totalTokens).toBe(1400);
  });
});

describe('budget enforcement', () => {
  it('blocks a call that would exceed the daily token limit', () => {
    process.env.AI_DAILY_TOKEN_LIMIT = '1000';
    recordUsage({ userId: user.id, taskType: 'chapter', model: 'gpt-4o-mini', promptTokens: 900, completionTokens: 200, source: 'openai' });

    expect(checkAiBudget(user.id, 100).allowed).toBe(false);
    expect(checkAiBudget(user.id, 100).reason).toMatch(/daily/i);
    expect(() => assertAiBudget(user.id, 100)).toThrowError(/daily ai token limit/i);

    // A different author is unaffected.
    const other = seedUser({ name: 'Other' });
    expect(() => assertAiBudget(other.id, 100)).not.toThrow();
  });

  it('blocks a call that would exceed the monthly cost limit', () => {
    process.env.AI_MONTHLY_COST_LIMIT_USD = '0.00001';
    recordUsage({ userId: user.id, taskType: 'chapter', model: 'gpt-4o', promptTokens: 5000, completionTokens: 5000, source: 'openai' });
    const check = checkAiBudget(user.id, 10);
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/monthly ai budget/i);
  });

  it('clamps completion tokens to the configured ceiling', () => {
    process.env.AI_MAX_COMPLETION_TOKENS = '8000';
    expect(clampCompletionTokens(50_000)).toBe(getAiBudget().maxCompletionTokens);
    expect(clampCompletionTokens(undefined)).toBeLessThanOrEqual(8000);
  });
});

describe('timeouts', () => {
  it('rejects a hung upstream instead of holding a job open', async () => {
    await expect(withTimeout(new Promise(() => {}), 30, 'chapter generation')).rejects.toThrow(/chapter generation/);
  });

  it('resolves normally when the promise is fast', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });
});
