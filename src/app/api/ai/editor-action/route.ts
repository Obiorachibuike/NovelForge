import { requireUser, requireChapter } from '@/lib/db/ownership';
import { editorActionPrompt } from '@/lib/ai/prompts';
import { editorActionSchema } from '@/types';
import { apiHandler, readJsonBody, HttpError } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { assertRegisteredModelOrAgnes } from '@/lib/ai/model-selection';
import { enqueue } from '@/lib/queue';
import '@/services/generation/universal-text';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Selection-based editing now uses the same durable background queue and
 * provider-backed incremental streaming as every other AI text task.
 */
export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  const body = await readJsonBody(req, value => editorActionSchema.parse(value));
  enforceRateLimit('aiEditor', user.id);
  enforceAiRateLimit('text', user.id);

  const chapter = await requireChapter(body.chapterId, user.id);
  if (chapter.status === 'approved' && body.action === 'rewrite') {
    throw new HttpError(409, 'This chapter is approved. Unlock it for editing before rewriting it.', 'chapter_approved');
  }

  const textModel = assertRegisteredModelOrAgnes(body.textModel, 'text-generation');
  const prompt = editorActionPrompt(body.action, {
    selection: body.selection || '',
    before: body.before,
    after: body.after,
    title: chapter.title,
  });

  const jobId = await enqueue({
    type: 'ai-content',
    userId: user.id,
    novelId: chapter.novelId,
    chapterId: chapter.id,
    payload: {
      generationType: `editor_${body.action}`,
      title: `${body.action.replace(/[-_]/g, ' ')} selection`,
      targetType: 'chapter',
      targetId: chapter.id,
      prompt: prompt.user,
      systemPrompt: prompt.system,
      maxTokens: 1500,
      temperature: 0.7,
      ...(textModel !== 'auto' ? { model: textModel } : {}),
      allowModelFallback: true,
    },
  });

  return Response.json({
    ok: true,
    jobId,
    status: 'QUEUED',
    generationType: `editor_${body.action}`,
    eventsUrl: `/api/generations/${jobId}/events`,
  }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
});
