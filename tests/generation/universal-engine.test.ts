import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { freshDatabase, db, seedUser, seedNovel } from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: 'Writer', email: 'writer@example.com' } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import {
  GENERATION_TYPE_VALUES,
  GenerationRequestSchema,
  isGenerationType,
  parseGenerationType,
  type GenerationType,
} from '@/lib/ai/generation/generation-types';
import { GenerationRegistry } from '@/lib/ai/generation/generation-registry';
import {
  generationRequestFromJobRow,
  isUniversalEngineJob,
  openChunkSink,
  UNIVERSAL_ENGINE,
} from '@/lib/ai/generation/generation-persistence';
import {
  UniversalGenerationService,
  resolveProviderChain,
} from '@/lib/ai/generation/generation-service';
import { validateGenerationRequest } from '@/lib/ai/generation/generation-validation';
import {
  cancelJob,
  enqueue,
  getJob,
  registerHandler,
  retryJob,
  runJob,
} from '@/lib/queue';
import { listGenerationEvents } from '@/lib/jobs/events';
import {
  getGenerationForUser,
  listGenerationsForUser,
  serializeGeneration,
} from '@/lib/jobs/generation-jobs';
import { POST as universalCreate } from '@/app/api/generations/universal/route';
import { GET as universalList } from '@/app/api/generations/universal/route';
import { GET as eventsRoute } from '@/app/api/generations/[jobId]/events/route';
import { POST as cancelRoute } from '@/app/api/generations/[jobId]/cancel/route';

let user: { id: string; email: string; name: string };
let other: { id: string; email: string; name: string };
let novel: { id: string; userId: string };

function jsonReq(url: string, body?: unknown, method = 'POST') {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function readAll(response: Response, timeoutMs = 4000): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, timeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
  }
  return text;
}

/** Minimal request factory for the engine's own unit-level tests. */
function request(overrides: Partial<Record<string, unknown>> = {}) {
  return validateGenerationRequest({
    projectId: novel.id,
    userId: user.id,
    generationType: 'novel_title',
    prompt: 'Title for a novel about a cartographer.',
    ...overrides,
  });
}

/** A context that records stages/progress for assertions. */
function recordingContext(cancelledAfter = Number.POSITIVE_INFINITY) {
  const stages: Array<{ stage: string; data?: Record<string, unknown> }> = [];
  const progress: number[] = [];
  let calls = 0;
  return {
    stages,
    progress,
    context: {
      setStage: (stage: string, data?: Record<string, unknown>) => { stages.push({ stage, data }); },
      setProgress: (percent: number) => { progress.push(percent); },
      isCancelled: () => { calls += 1; return calls > cancelledAfter; },
      signal: new AbortController().signal,
    },
  };
}

/**
 * Mocks the provider layer's text entry point so no test makes a network call.
 * `onText` is fed *cumulative* text, exactly like the real adapters.
 */
vi.mock('@/lib/ai/text-generation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai/text-generation')>('@/lib/ai/text-generation');
  return {
    ...actual,
    generateTextDetailed: vi.fn(async (input: any) => {
      if (input.onText) {
        const text = 'The Cartographer of Ashgrave';
        input.onText('');
        input.onText('The Cartographer');
        input.onText(text);
      }
      return {
        text: 'The Cartographer of Ashgrave',
        meta: { source: 'agnes', model: 'agnes-2.5-flash', provider: 'agnes-ai', usedFallback: false, attempts: 1, latencyMs: 12 },
      };
    }),
  };
});

vi.mock('@/lib/ai/image-generation', () => ({
  generateImage: vi.fn(async () => ({
    image: Buffer.from('89504e470d0a1a0a', 'hex'),
    mimeType: 'image/png',
    provider: 'agnes-ai',
    requestedModelId: 'auto',
    actualModelId: 'agnes-image-2.5-flash',
    fallbackUsed: false,
    attempts: 1,
    latencyMs: 20,
    width: 1024,
    height: 1024,
  })),
}));

vi.mock('@/lib/storage', async () => {
  const actual = await vi.importActual<typeof import('@/lib/storage')>('@/lib/storage');
  return {
    ...actual,
    saveFile: vi.fn(async () => ({ key: 'images/test.png', url: '/api/files/images/test.png' })),
  };
});

beforeEach(() => {
  freshDatabase();
  GenerationRegistry.clear();
  user = seedUser();
  other = seedUser();
  novel = seedNovel(user.id);
  session.userId = user.id;
  // A real provider is "configured" so the engine takes the hosted path.
  process.env.AGNES_API_KEY = 'test-agnes-key';
  delete process.env.AI_DEMO_MODE;
});

afterEach(() => {
  GenerationRegistry.clear();
  session.userId = null;
  delete process.env.AGNES_API_KEY;
  process.env.AI_DEMO_MODE = 'true';
  vi.clearAllMocks();
});

describe('generation vocabulary', () => {
  it('has no duplicate generation types and keeps TypeScript and Zod in sync', () => {
    expect(new Set(GENERATION_TYPE_VALUES).size).toBe(GENERATION_TYPE_VALUES.length);
    for (const type of GENERATION_TYPE_VALUES) {
      expect(GenerationRequestSchema.safeParse({
        projectId: 'p', userId: 'u', generationType: type, prompt: 'x',
        ...(type === 'custom' ? { customType: 'my-feature' } : {}),
      }).success).toBe(true);
    }
    // Every supported generation type the audit requires is present.
    for (const required of [
      'novel_title', 'novel_description', 'novel_summary', 'story_idea', 'story_outline',
      'chapter_outline', 'chapter', 'page', 'scene', 'character', 'character_backstory',
      'character_relationship', 'worldbuilding', 'location', 'culture', 'history',
      'book_blurb', 'author_bio', 'marketing_copy', 'rewrite', 'expand', 'summarize',
      'shorten', 'proofread', 'humanize', 'premise', 'outline', 'memory', 'image', 'custom',
    ]) {
      expect(isGenerationType(required)).toBe(true);
    }
    expect(isGenerationType('not_a_type')).toBe(false);
    expect(parseGenerationType('custom:my-feature')).toBe('custom');
    expect(parseGenerationType('nope')).toBeNull();
  });

  it('rejects unknown types and an unchecked custom type instead of widening to string', () => {
    expect(GenerationRequestSchema.safeParse({
      projectId: 'p', userId: 'u', generationType: 'definitely_not_real', prompt: 'x',
    }).success).toBe(false);
    expect(GenerationRequestSchema.safeParse({
      projectId: 'p', userId: 'u', generationType: 'custom', prompt: 'x',
    }).success).toBe(false);
    expect(GenerationRequestSchema.safeParse({
      projectId: 'p', userId: 'u', generationType: 'custom', customType: 'my feature!', prompt: 'x',
    }).success).toBe(false);
  });

  it('enforces prompt and provider validation', () => {
    expect(GenerationRequestSchema.safeParse({
      projectId: 'p', userId: 'u', generationType: 'scene', prompt: '',
    }).success).toBe(false);
    expect(GenerationRequestSchema.safeParse({
      projectId: 'p', userId: 'u', generationType: 'scene', prompt: 'x', provider: 'gopher',
    }).success).toBe(false);
    expect(GenerationRequestSchema.safeParse({
      projectId: 'p', userId: 'u', generationType: 'scene', prompt: 'x'.repeat(100_001),
    }).success).toBe(false);
  });
});

describe('generation registry', () => {
  it('registers, looks up, lists and removes handlers', () => {
    const handler = async () => ({ text: 'x' });
    GenerationRegistry.register('scene', handler);
    expect(GenerationRegistry.hasHandler('scene')).toBe(true);
    expect(GenerationRegistry.has('scene')).toBe(true);
    expect(GenerationRegistry.getHandler('scene')).toBe(handler);
    expect(GenerationRegistry.listTypes()).toEqual(['scene']);
    expect(GenerationRegistry.unregister('scene')).toBe(true);
    expect(GenerationRegistry.hasHandler('scene')).toBe(false);
  });

  it('refuses to register an unknown generation type', () => {
    expect(() => GenerationRegistry.register('nope' as GenerationType, async () => ({}))).toThrow(/unknown generation type/);
  });
});

describe('provider routing', () => {
  it('uses Agnes first and only falls back when fallback is allowed', () => {
    expect(resolveProviderChain({}, { agnes: true, huggingface: true, openai: true }))
      .toEqual(['agnes', 'huggingface', 'openai']);
    expect(resolveProviderChain({}, { agnes: true, huggingface: false, openai: false }))
      .toEqual(['agnes']);
    expect(resolveProviderChain({ provider: 'openai' }, { agnes: true, huggingface: true, openai: true }))
      .toEqual(['openai', 'agnes', 'huggingface']);
    // Fallback disabled: exactly the requested provider, no silent switch.
    expect(resolveProviderChain(
      { provider: 'huggingface', metadata: { allowFallback: false } },
      { agnes: true, huggingface: true, openai: true },
    )).toEqual(['huggingface']);
  });
});

describe('job creation and execution', () => {
  it('creates a durable universal job that the worker can rebuild from the row', async () => {
    const jobId = await UniversalGenerationService.createJob(request({
      stream: true,
      idempotencyKey: 'title:1',
    }));
    const job = (await getJob(jobId))!;

    expect(job.taskType).toBe('novel_title');
    expect(job.status).toBe('queued');
    expect(isUniversalEngineJob(job)).toBe(true);
    expect(UniversalGenerationService.ownsJob(job)).toBe(true);

    // A duplicate create with the same idempotency key returns the same row.
    const again = await UniversalGenerationService.createJob(request({ stream: true, idempotencyKey: 'title:1' }));
    expect(again).toBe(jobId);

    const rebuilt = generationRequestFromJobRow(job);
    expect(rebuilt.projectId).toBe(novel.id);
    expect(rebuilt.userId).toBe(user.id);
    expect(rebuilt.generationType).toBe('novel_title');
    expect(rebuilt.prompt).toContain('cartographer');
    expect(rebuilt.stream).toBe(true);
  });

  it('executes with the real job id and streams persisted, ordered chunks', async () => {
    const jobId = await UniversalGenerationService.createJob(request({ stream: true }));
    const result = await runJob(jobId, 'test-worker');
    expect(result.status).toBe('completed');

    const job = (await getJob(jobId))!;
    expect(job.status).toBe('completed');
    expect(job.currentStage).toBe('COMPLETED');
    // Provenance names the provider/model that actually produced the text.
    expect(job.provider).toBe('agnes-ai');
    expect(job.actualModel).toBe('agnes-2.5-flash');

    const contentEvents = listGenerationEvents(jobId).filter(e => e.type === 'generation_content');
    expect(contentEvents.length).toBeGreaterThan(0);

    const sequences = contentEvents.map(e => JSON.parse(e.payload!).sequence as number);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);

    // Cumulative provider text is split into deltas: concatenating the persisted
    // chunks reproduces the generated text exactly (no duplication).
    const rebuilt = contentEvents.map(e => JSON.parse(e.payload!).delta as string).join('');
    expect(rebuilt).toBe('The Cartographer of Ashgrave');

    const stored = JSON.parse(job.result!);
    expect(stored.text).toBe('The Cartographer of Ashgrave');
    expect(stored.partialText).toBe('The Cartographer of Ashgrave');
  });

  it('does not fabricate chunks when the caller did not ask for streaming', async () => {
    const jobId = await UniversalGenerationService.createJob(request({ stream: false }));
    await runJob(jobId, 'test-worker');
    const contentEvents = listGenerationEvents(jobId).filter(e => e.type === 'generation_content');
    expect(contentEvents).toHaveLength(0);
    expect((await getJob(jobId))?.status).toBe('completed');
  });

  it('reports the total progress for a completed non-chapter job', async () => {
    const jobId = await UniversalGenerationService.createJob(request());
    await runJob(jobId, 'test-worker');
    const job = (await getJob(jobId))!;
    expect(job.progressPercentage).toBe(100);
    expect(serializeGeneration(getGenerationForUser(user.id, jobId)!).status).toBe('COMPLETED');
  });

  it('publishes queued, started, content, progress and completed events', async () => {
    const jobId = await UniversalGenerationService.createJob(request({ stream: true }));
    await runJob(jobId, 'test-worker');
    const types = listGenerationEvents(jobId).map(e => e.type);
    expect(types[0]).toBe('generation_queued');
    expect(types).toContain('generation_started');
    expect(types).toContain('generation_content');
    expect(types).toContain('generation_progress');
    expect(types[types.length - 1]).toBe('generation_completed');
  });

  it('runs registered custom handlers for a built-in type', async () => {
    GenerationRegistry.register('novel_title', async (req, ctx) => {
      ctx.setStage('GENERATING_CONTENT');
      return { text: `custom:${req.prompt.slice(0, 4)}`, meta: { source: 'agnes', model: 'm', usedFallback: false } };
    });
    const jobId = await UniversalGenerationService.createJob(request());
    await runJob(jobId, 'test-worker');
    const job = (await getJob(jobId))!;
    expect(JSON.parse(job.result!).text).toBe('custom:Titl');
  });

  it('never executes a job whose row does not match the request', async () => {
    const jobId = await UniversalGenerationService.createJob(request());
    await expect(
      UniversalGenerationService.executeJob(
        jobId,
        request({ userId: other.id, projectId: seedNovel(other.id).id }),
        recordingContext().context,
      ),
    ).rejects.toThrow(/does not match its persisted job/);
    // The row was not finalised by the failed attempt.
    expect((await getJob(jobId))?.status).toBe('queued');
  });
});

describe('image generation', () => {
  it('finalises the image job itself (never the project id) and records the asset', async () => {
    const jobId = await UniversalGenerationService.createJob(request({
      generationType: 'image',
      prompt: 'A dark fantasy cover with a glass crown',
    }));
    await runJob(jobId, 'test-worker');

    const job = (await getJob(jobId))!;
    expect(job.status).toBe('completed');
    expect(job.taskType).toBe('image');

    const stored = JSON.parse(job.result!);
    expect(stored.assets.url).toBe('/api/files/images/test.png');
    expect(stored.meta.provider).toBe('agnes-ai');

    const asset = db().prepare('SELECT * FROM image_assets WHERE novelId=? AND kind=?').get(novel.id, 'generated') as any;
    expect(asset).toBeTruthy();
    expect(asset.userId).toBe(user.id);

    // The novel row was not touched as if it were the job.
    const novelRow = db().prepare('SELECT * FROM novels WHERE id=?').get(novel.id) as any;
    expect(novelRow.status).toBe('draft');
  });
});

describe('cancellation and failure handling', () => {
  it('cancels a queued universal job and never resurrects it', async () => {
    const jobId = await UniversalGenerationService.createJob(request());
    expect(await UniversalGenerationService.cancel(jobId)).toBe(true);
    expect((await getJob(jobId))?.status).toBe('cancelled');

    // A cancelled job cannot be claimed.
    const result = await runJob(jobId, 'test-worker');
    expect(result.status).toBe('skipped');
    expect((await getJob(jobId))?.status).toBe('cancelled');
  });

  it('marks a permanently failing job failed once and records a retryable flag', async () => {
    GenerationRegistry.register('novel_title', async () => {
      throw Object.assign(new Error('Invalid API key provided'), { status: 401, code: 'invalid_api_key' });
    });
    const jobId = await UniversalGenerationService.createJob(request());
    const result = await runJob(jobId, 'test-worker');
    expect(result.status).toBe('failed');

    const job = (await getJob(jobId))!;
    expect(job.status).toBe('failed');
    expect(job.retryable).toBe(0);
    const failures = listGenerationEvents(jobId).filter(e => e.type === 'generation_failed');
    expect(failures).toHaveLength(1);
  });

  it('re-queues a transient failure with a backoff and allows a retry', async () => {
    let attempt = 0;
    GenerationRegistry.register('novel_title', async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('upstream socket hang up');
      return { text: 'Recovered title', meta: { source: 'agnes', model: 'm', usedFallback: false } };
    });
    const jobId = await UniversalGenerationService.createJob(request());
    const first = await runJob(jobId, 'test-worker');
    expect(first.status).toBe('queued');
    const queued = (await getJob(jobId))!;
    expect(queued.status).toBe('queued');
    expect(queued.error).toMatch(/socket hang up/);

    db().prepare('UPDATE generation_jobs SET scheduledAt=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), jobId);
    const second = await runJob(jobId, 'test-worker');
    expect(second.status).toBe('completed');
    expect(JSON.parse((await getJob(jobId))!.result!).text).toBe('Recovered title');

    // A retry of a completed job is refused.
    expect(await retryJob(jobId)).toBe(false);
  });

  it('keeps chunk text durable across a simulated worker restart', async () => {
    const jobId = await UniversalGenerationService.createJob(request({ stream: true }));
    // Simulate a worker that persisted chunks and then died.
    db().prepare("UPDATE generation_jobs SET status='processing' WHERE id=?").run(jobId);
    const sink = openChunkSink(jobId);
    sink.append('The map ');
    sink.append('remembers.');
    expect(sink.text).toBe('The map remembers.');
    const sequenceAfterCrash = sink.sequence;

    // A new sink resumes from the persisted text and a higher sequence.
    const resumed = openChunkSink(jobId);
    expect(resumed.text).toBe('The map remembers.');
    expect(resumed.append(' Still true.')).toBeGreaterThan(sequenceAfterCrash);
  });
});

describe('SSE stream', () => {
  it('replays persisted content and terminates for a universal job', async () => {
    const jobId = await UniversalGenerationService.createJob(request({ stream: true }));
    await runJob(jobId, 'test-worker');

    const response = await eventsRoute(
      new Request(`http://localhost:3000/api/generations/${jobId}/events`),
      { params: { jobId } },
    );
    expect(response.status).toBe(200);
    const text = await readAll(response);
    expect(text).toContain('event: generation_snapshot');
    expect(text).toContain('event: generation_content');
    expect(text).toContain('event: generation_completed');
    expect(text).toContain('"engine":"universal"');
    expect(text).toContain('The Cartographer');
  });

  it('replays only what a reconnecting client missed', async () => {
    const jobId = await UniversalGenerationService.createJob(request({ stream: true }));
    await runJob(jobId, 'test-worker');

    const events = listGenerationEvents(jobId);
    const first = events[0];
    const response = await eventsRoute(
      new Request(`http://localhost:3000/api/generations/${jobId}/events`, {
        headers: { 'last-event-id': String(first.seq) },
      }),
      { params: { jobId } },
    );
    const text = await readAll(response);
    expect(text).not.toContain(`id: ${first.seq}\n`);
    expect(text).toContain('event: generation_completed');
  });

  it('refuses to stream another user’s universal job', async () => {
    const jobId = await UniversalGenerationService.createJob(request());
    session.userId = other.id;
    const response = await eventsRoute(
      new Request(`http://localhost:3000/api/generations/${jobId}/events`),
      { params: { jobId } },
    );
    expect(response.status).toBe(404);
  });

  it('refuses to cancel another user’s universal job', async () => {
    const jobId = await UniversalGenerationService.createJob(request());
    session.userId = other.id;
    const response = await cancelRoute(
      new Request(`http://localhost:3000/api/generations/${jobId}/cancel`, { method: 'POST' }),
      { params: { jobId } },
    );
    expect(response.status).toBe(404);
    expect((await getJob(jobId))?.status).toBe('queued');
  });
});

describe('universal HTTP API', () => {
  it('creates any generation type for the signed-in user', async () => {
    const response = await universalCreate(jsonReq('/api/generations/universal', {
      projectId: novel.id,
      userId: other.id, // spoofing attempt: ignored in favour of the session
      generationType: 'character',
      targetType: 'character',
      prompt: 'A rival archivist with a secret.',
    }));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.jobId).toBeTruthy();
    expect(body.eventsUrl).toBe(`/api/generations/${body.jobId}/events`);

    const job = (await getJob(body.jobId))!;
    expect(job.userId).toBe(user.id);
    expect(job.taskType).toBe('character');
    expect(isUniversalEngineJob(job)).toBe(true);
  });

  it('rejects a project the caller does not own', async () => {
    const otherNovel = seedNovel(other.id);
    const response = await universalCreate(jsonReq('/api/generations/universal', {
      projectId: otherNovel.id,
      generationType: 'novel_title',
      prompt: 'Title',
    }));
    expect(response.status).toBe(404);
    expect(db().prepare('SELECT COUNT(*) AS c FROM generation_jobs').get()).toEqual({ c: 0 });
  });

  it('validates the request body', async () => {
    const response = await universalCreate(jsonReq('/api/generations/universal', {
      projectId: novel.id,
      generationType: 'unknown_type',
      prompt: 'x',
    }));
    expect(response.status).toBe(400);
  });

  it('lists every generation type the caller owns', async () => {
    await UniversalGenerationService.createJob(request({ generationType: 'novel_title', idempotencyKey: 'a' }));
    await UniversalGenerationService.createJob(request({ generationType: 'scene', idempotencyKey: 'b' }));

    const rows = listGenerationsForUser(user.id, { limit: 10 });
    expect(rows.map(r => r.taskType).sort()).toEqual(['novel_title', 'scene']);

    const response = await universalList(new Request(`http://localhost:3000/api/generations/universal?limit=10`));
    const body = await response.json();
    expect(body.count).toBe(2);
    expect(body.generations.every((g: any) => g.eventsUrl)).toBe(true);
  });
});

describe('legacy jobs stay on the legacy engine', () => {
  it('does not route a legacy row into the universal engine', async () => {
    registerHandler('outline', async ctx => {
      ctx.setStage('PREPARING_AI_PROMPT');
      return { acts: [], chapters: [{ chapterNumber: 1 }] };
    });
    const jobId = await enqueue({
      type: 'outline',
      userId: user.id,
      novelId: novel.id,
      payload: { structureType: 'three-act' },
    });
    const row = (await getJob(jobId))!;
    expect(isUniversalEngineJob(row)).toBe(false);
    expect(UniversalGenerationService.ownsJob(row)).toBe(false);

    const result = await runJob(jobId, 'test-worker');
    expect(result.status).toBe('completed');
    expect((await getJob(jobId))?.status).toBe('completed');
  });

  it('fails a universal job that is missing its persisted payload marker', async () => {
    // A row created directly (no engine marker) must never be executed by the
    // universal engine, even when an identical handler exists.
    const now = new Date().toISOString();
    db().prepare(
      `INSERT INTO generation_jobs (id,userId,novelId,taskType,payload,status,attempts,maxAttempts,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('legacy-row', user.id, novel.id, 'novel_title', JSON.stringify({ prompt: 'x' }), 'processing', 1, 3, now, now);

    await expect(
      UniversalGenerationService.executeJob('legacy-row', request(), recordingContext().context),
    ).rejects.toThrow(/not owned by the universal engine/);
  });

  it('cancels a legacy job through the same durable path', async () => {
    const jobId = await enqueue({
      type: 'memory',
      userId: user.id,
      novelId: novel.id,
      payload: { chapterId: 'chapter-1' },
    });
    expect(cancelJob(jobId)).toBe(true);
    expect((await getJob(jobId))?.status).toBe('cancelled');
  });
});
