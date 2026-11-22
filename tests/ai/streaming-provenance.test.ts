import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, freshDatabase, seedNovel, seedUser } from '../helpers/db';

const openai = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/lib/ai/provider', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai/provider')>('@/lib/ai/provider');
  return {
    ...actual,
    getOpenAI: () => process.env.OPENAI_API_KEY && process.env.AI_DEMO_MODE !== 'true'
      ? { chat: { completions: { create: openai.create } } }
      : null,
  };
});

import { __setFetchForTests as setAgnesFetch } from '@/lib/ai/agnes-client';
import { __setFetchForTests as setHfFetch } from '@/lib/ai/huggingface-client';
import { __setAgnesSleepForTests } from '@/lib/ai/agnes-generation';
import { __setRetrySleepForTests } from '@/lib/ai/retry-policy';
import { resetCircuitBreakersForTests } from '@/lib/ai/circuit-breaker';
import { resetVerificationCacheForTests } from '@/lib/ai/model-verification';
import { patchModel, syncRegistry } from '@/lib/ai/model-registry';
import { generateTextDetailed } from '@/lib/ai/text-generation';
import { UniversalGenerationService } from '@/lib/ai/generation/generation-service';
import { getJob, runJob } from '@/lib/queue';
import { listGenerationEvents } from '@/lib/jobs/events';
import { getGenerationForUser, serializeGeneration } from '@/lib/jobs/generation-jobs';
import { agnesHandler, chatHandler, jsonResponse, mockFetch, useAgnesBackend } from './helpers';

let restoreEnv: () => void;
let userId: string;
let novelId: string;

/** Emit one real SSE delta before the upstream connection fails. */
function interruptedStream(text: string): Response {
  let sent = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      } else {
        controller.error(Object.assign(new Error('socket hang up'), { status: 503 }));
      }
    },
  }), { headers: { 'content-type': 'text/event-stream', 'x-inference-provider': 'together' } });
}

function successfulStream(text: string, model: string): Response {
  return new Response(
    `data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream', 'x-inference-provider': 'together' } },
  );
}

function eligibleHfModels() {
  syncRegistry();
  for (const model of ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct']) {
    patchModel(model, { availabilityStatus: 'available', pricingStatus: 'free', provider: 'together' });
  }
}

beforeEach(() => {
  freshDatabase();
  resetCircuitBreakersForTests();
  resetVerificationCacheForTests();
  restoreEnv = useAgnesBackend();
  __setAgnesSleepForTests(async () => {});
  __setRetrySleepForTests(async () => {});
  openai.create.mockReset();
  userId = seedUser().id;
  novelId = seedNovel(userId).id;
});

afterEach(() => {
  setAgnesFetch(null);
  setHfFetch(null);
  __setAgnesSleepForTests(null);
  __setRetrySleepForTests(null);
  restoreEnv();
});

describe('streaming attempts and model attribution', () => {
  it('does not retry Agnes, switch to Hugging Face, or return a stub after emitting text', async () => {
    eligibleHfModels();
    const fetch = mockFetch([
      agnesHandler(() => interruptedStream('Agnes partial.')),
      chatHandler(body => successfulStream('Hugging Face replacement.', body.model)),
    ]);
    setAgnesFetch(fetch as unknown as typeof globalThis.fetch);
    setHfFetch(fetch as unknown as typeof globalThis.fetch);
    const snapshots: string[] = [];

    await expect(generateTextDetailed({
      messages: [{ role: 'user', content: 'Write a scene.' }],
      userId, novelId, taskType: 'scene',
      allowModelFallback: true, allowFallbackOnError: true,
      onText: text => snapshots.push(text),
    })).rejects.toThrow(/socket hang up/);
    expect(snapshots).toEqual(['', 'Agnes partial.']);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url).toContain('agnes');
  });

  it('does not retry or switch HF models after streaming has started', async () => {
    eligibleHfModels();
    process.env.AI_MAX_RETRIES_PER_MODEL = '2';
    const fetch = mockFetch([chatHandler(body => body.model === 'Qwen/Qwen2.5-7B-Instruct'
      ? interruptedStream('First model partial.')
      : successfulStream('Different model.', body.model))]);
    setHfFetch(fetch as unknown as typeof globalThis.fetch);
    const snapshots: string[] = [];

    await expect(generateTextDetailed({
      messages: [{ role: 'user', content: 'Write a scene.' }],
      userId, novelId, taskType: 'scene', forceProvider: 'huggingface',
      model: 'Qwen/Qwen2.5-7B-Instruct', allowModelFallback: true, allowFallbackOnError: true,
      onText: text => snapshots.push(text),
    })).rejects.toThrow();
    expect(snapshots).toEqual(['', 'First model partial.']);
    expect(fetch.calls).toHaveLength(1);
  });

  it('still falls back normally if the first provider fails before emitting any text', async () => {
    eligibleHfModels();
    const fetch = mockFetch([chatHandler(body => body.model === 'Qwen/Qwen2.5-7B-Instruct'
      ? jsonResponse({ error: 'temporarily unavailable' }, 503)
      : successfulStream('A complete answer.', body.model))]);
    setHfFetch(fetch as unknown as typeof globalThis.fetch);
    const snapshots: string[] = [];

    const result = await generateTextDetailed({
      messages: [{ role: 'user', content: 'Write a scene.' }],
      userId, novelId, taskType: 'scene', forceProvider: 'huggingface',
      model: 'Qwen/Qwen2.5-7B-Instruct', allowModelFallback: true,
      onText: text => snapshots.push(text),
    });
    expect(fetch.calls.length).toBeGreaterThan(1);
    expect(snapshots).toEqual(['', 'A complete answer.']);
    expect(result).toMatchObject({ text: 'A complete answer.', meta: { source: 'huggingface', provider: 'together', modelFallbackUsed: true } });
    expect(result.meta.actualModel).not.toBe('Qwen/Qwen2.5-7B-Instruct');
  });

  it('ignores late output from a timed-out HF attempt after another model succeeds', async () => {
    eligibleHfModels();
    process.env.AI_REQUEST_TIMEOUT_MS = '1000';
    let resolveLate!: (response: Response) => void;
    const fetch = mockFetch([chatHandler(body => body.model === 'Qwen/Qwen2.5-7B-Instruct'
      ? new Promise<Response>(resolve => { resolveLate = resolve; })
      : successfulStream('Successful fallback.', body.model))]);
    setHfFetch(fetch as unknown as typeof globalThis.fetch);
    const snapshots: string[] = [];

    const result = await generateTextDetailed({
      messages: [{ role: 'user', content: 'Write a scene.' }],
      userId, novelId, taskType: 'scene', forceProvider: 'huggingface',
      model: 'Qwen/Qwen2.5-7B-Instruct', allowModelFallback: true,
      onText: text => snapshots.push(text),
    });
    expect(result.text).toBe('Successful fallback.');
    expect(result.meta.modelFallbackUsed).toBe(true);
    resolveLate(successfulStream('Late old output.', 'Qwen/Qwen2.5-7B-Instruct'));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(snapshots).toEqual(['', 'Successful fallback.']);
  });

  it('does not retry OpenAI or return placeholder text after a streamed failure', async () => {
    delete process.env.AGNES_API_KEY;
    delete process.env.HF_TOKEN;
    delete process.env.HUGGINGFACEHUB_API_TOKEN;
    process.env.OPENAI_API_KEY = 'test-key';
    openai.create.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { model: 'gpt-test', choices: [{ delta: { content: 'OpenAI partial.' } }] };
        throw Object.assign(new Error('socket hang up'), { status: 503 });
      },
    });
    const snapshots: string[] = [];

    await expect(generateTextDetailed({
      messages: [{ role: 'user', content: 'Write a scene.' }],
      userId, novelId, taskType: 'scene', forceProvider: 'openai',
      allowFallbackOnError: true, onText: text => snapshots.push(text),
    })).rejects.toThrow(/socket hang up/);
    expect(snapshots).toEqual(['', 'OpenAI partial.']);
    expect(openai.create).toHaveBeenCalledTimes(1);
  });

  it('preserves a failed draft until a retry replaces it, without mixing attempts or attribution', async () => {
    let calls = 0;
    const fetch = mockFetch([agnesHandler(() => {
      calls += 1;
      return calls === 1 ? interruptedStream('Abandoned draft.') : successfulStream('Fresh answer.', 'agnes-reported-version');
    })]);
    setAgnesFetch(fetch as unknown as typeof globalThis.fetch);
    const jobId = await UniversalGenerationService.createJob({
      projectId: novelId, userId, generationType: 'scene', prompt: 'Write a scene.',
      provider: 'agnes', stream: true, metadata: { allowFallback: true },
    });

    expect((await runJob(jobId, 'test-worker')).status).toBe('queued');
    let job = (await getJob(jobId))!;
    expect(job.actualModel).toBeNull();
    expect(JSON.parse(job.result!).partialText).toBe('Abandoned draft.');
    expect(calls).toBe(1);

    db().prepare('UPDATE generation_jobs SET scheduledAt=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), jobId);
    expect((await runJob(jobId, 'test-worker')).status).toBe('completed');
    job = (await getJob(jobId))!;
    const result = JSON.parse(job.result!);
    expect(result.text).toBe('Fresh answer.');
    expect(result.partialText).toBe('Fresh answer.');
    expect(job).toMatchObject({ actualModel: 'agnes-reported-version', provider: 'agnes-ai', fallbackCount: 0 });
    const contents = listGenerationEvents(jobId).filter(event => event.type === 'generation_content').map(event => JSON.parse(event.payload!));
    expect(contents.map(event => event.delta)).toEqual(['Abandoned draft.', 'Fresh answer.']);
    expect(contents[1]).toMatchObject({ replace: true, totalLength: 'Fresh answer.'.length });
    expect(contents[1].sequence).toBeGreaterThan(contents[0].sequence);
    expect(result.partialSequence).toBe(contents[1].sequence);
    expect(serializeGeneration(getGenerationForUser(userId, jobId)!)).toMatchObject({
      partialText: 'Fresh answer.', partialSequence: contents[1].sequence,
      actualModel: 'agnes-reported-version', provider: 'agnes-ai',
    });
  });
});
