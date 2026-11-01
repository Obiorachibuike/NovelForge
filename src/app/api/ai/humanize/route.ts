import { z } from 'zod';
import { apiHandler, readJsonBody, HttpError, MAX_JSON_BYTES } from '@/lib/api/http';
import { requireUser, requireNovel } from '@/lib/db/ownership';
import { getDb } from '@/lib/db';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { enqueue } from '@/lib/queue';
import { humanizerModels } from '@/services/humanization/registry';
import '@/services/generation/universal-text';

const schema = z.object({
  novelId: z.string().min(1).max(64),
  text: z.string().min(1).max(30_000),
  modelId: z.string().optional(),
  mode: z.enum(['light', 'natural', 'deep']).optional(),
  instructions: z.string().max(800).optional(),
  context: z.string().max(2500).optional(),
});

export const GET = apiHandler(async () => {
  await requireUser();
  return Response.json({
    models: humanizerModels,
    defaultModel: process.env.HUGGINGFACE_HUMANIZER_MODEL || 'gohumanize/gohumanize-open-humanizer',
  });
});

/** Humanization now runs in the durable worker and streams real provider text. */
export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  const body = await readJsonBody(req, value => schema.parse(value), MAX_JSON_BYTES.document);
  await requireNovel(body.novelId, user.id);
  enforceRateLimit('aiGeneration', user.id);
  enforceAiRateLimit('text', user.id);
  const db = getDb();
  const active = db.prepare("SELECT COUNT(*) AS total FROM generation_jobs WHERE userId=? AND status IN ('queued','processing')").get(user.id) as { total: number };
  const maxActive = Math.max(1, Number(process.env.GENERATION_MAX_ACTIVE_PER_USER || 3));
  if (Number(active.total) >= maxActive) {
    throw new HttpError(429, `You already have ${maxActive} active AI generations. Wait for one to finish or cancel it before starting another.`, 'generation_concurrency_limit');
  }

  const jobId = await enqueue({
    type: 'ai-content',
    userId: user.id,
    novelId: body.novelId,
    payload: {
      generationType: 'humanize',
      operation: 'humanize',
      title: 'Humanize passage',
      prompt: body.text,
      ...(body.modelId ? { modelId: body.modelId } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.instructions ? { instructions: body.instructions } : {}),
      ...(body.context ? { context: body.context } : {}),
    },
  });

  return Response.json({
    ok: true,
    jobId,
    status: 'QUEUED',
    generationType: 'humanize',
    eventsUrl: `/api/generations/${jobId}/events`,
    statusUrl: `/api/generations/${jobId}`,
  }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
});
