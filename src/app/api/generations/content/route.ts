import { z } from 'zod';
import { requireChapter, requireNovel, requireUser } from '@/lib/db/ownership';
import { getDb } from '@/lib/db';
import { apiHandler, readJsonBody, HttpError } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { assertRegisteredModelOrAgnes } from '@/lib/ai/model-selection';
import { enqueue } from '@/lib/queue';
import '@/services/generation/universal-text';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const generationTypes = [
  'novel_title', 'novel_description', 'novel_summary',
  'story_idea', 'story_outline', 'chapter_outline',
  'page', 'scene', 'character', 'character_backstory',
  'character_relationship', 'worldbuilding', 'location', 'culture',
  'history', 'book_blurb', 'author_bio', 'marketing_copy',
  'rewrite', 'expand', 'summarize', 'shorten', 'proofread',
  'humanize', 'custom',
] as const;

const schema = z.object({
  novelId: z.string().min(1).max(64),
  chapterId: z.string().min(1).max(64).optional(),
  generationType: z.enum(generationTypes),
  prompt: z.string().trim().min(1).max(30_000),
  systemPrompt: z.string().max(12_000).optional(),
  model: z.string().max(200).optional(),
  maxTokens: z.coerce.number().int().min(16).max(8_000).optional(),
  temperature: z.coerce.number().min(0).max(2).optional(),
  allowFallback: z.boolean().default(true),
  targetType: z.string().max(80).optional(),
  targetId: z.string().max(128).optional(),
  title: z.string().max(240).optional(),
  idempotencyKey: z.string().max(160).optional(),
});

/**
 * POST /api/generations/content
 * Creates a durable, provider-streamed text generation and returns immediately.
 * The worker continues if the caller navigates away or disconnects.
 */
export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  enforceRateLimit('aiGeneration', user.id);
  enforceAiRateLimit('text', user.id);
  const body = await readJsonBody(req, value => schema.parse(value));
  await requireNovel(body.novelId, user.id);
  const chapterId = body.chapterId || (body.targetType === 'chapter' ? body.targetId : undefined);
  if (chapterId) {
    const chapter = await requireChapter(chapterId, user.id);
    if (chapter.novelId !== body.novelId) throw new HttpError(404, 'Chapter not found', 'chapter_not_found');
  }

  const db = getDb();
  const activeUser = db.prepare("SELECT COUNT(*) AS total FROM generation_jobs WHERE userId=? AND status IN ('queued','processing')").get(user.id) as { total: number };
  const configuredUserLimit = Number(process.env.GENERATION_MAX_ACTIVE_PER_USER || 3);
  const maxPerUser = Number.isFinite(configuredUserLimit) && configuredUserLimit > 0 ? Math.floor(configuredUserLimit) : 3;
  if (Number(activeUser.total) >= maxPerUser) {
    throw new HttpError(429, `You already have ${maxPerUser} active AI generations. Wait for one to finish or cancel it before starting another.`, 'generation_concurrency_limit');
  }
  const activeNovel = db.prepare("SELECT COUNT(*) AS total FROM generation_jobs WHERE userId=? AND novelId=? AND taskType!='chapter' AND status IN ('queued','processing')").get(user.id, body.novelId) as { total: number };
  const configuredNovelLimit = Number(process.env.GENERATION_MAX_ACTIVE_CONTENT_PER_NOVEL || 3);
  const maxPerNovel = Number.isFinite(configuredNovelLimit) && configuredNovelLimit > 0 ? Math.floor(configuredNovelLimit) : 3;
  if (Number(activeNovel.total) >= maxPerNovel) {
    throw new HttpError(429, `This novel already has ${maxPerNovel} active AI content jobs.`, 'novel_generation_concurrency_limit');
  }

  const model = body.model
    ? assertRegisteredModelOrAgnes(body.model, 'text-generation')
    : undefined;

  const jobId = await enqueue({
    type: 'ai-content',
    userId: user.id,
    novelId: body.novelId,
    ...(chapterId ? { chapterId } : {}),
    ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    payload: {
      generationType: body.generationType,
      prompt: body.prompt,
      ...(body.systemPrompt ? { systemPrompt: body.systemPrompt } : {}),
      ...(model && model !== 'auto' ? { model } : {}),
      maxTokens: body.maxTokens ?? 2048,
      temperature: body.temperature ?? 0.8,
      allowModelFallback: body.allowFallback,
      ...(body.targetType ? { targetType: body.targetType } : {}),
      ...(body.targetId ? { targetId: body.targetId } : {}),
      ...(body.title ? { title: body.title } : {}),
    },
  });

  return Response.json({
    ok: true,
    jobId,
    status: 'QUEUED',
    generationType: body.generationType,
    statusUrl: `/api/generations/${jobId}`,
    eventsUrl: `/api/generations/${jobId}/events`,
    cancelUrl: `/api/generations/${jobId}/cancel`,
    retryUrl: `/api/generations/${jobId}/retry`,
  }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
});
