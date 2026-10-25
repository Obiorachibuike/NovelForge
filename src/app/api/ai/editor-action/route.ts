import { requireUser, requireChapter, jsonError } from '@/lib/db/ownership';
import { generateTextDetailed } from '@/lib/ai/text-generation';
import { editorActionPrompt } from '@/lib/ai/prompts';
import { editorActionSchema } from '@/types';
import { apiHandler, readJsonBody, HttpError } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { enforceAiRateLimit } from '@/lib/ai/rate-limit';
import { assertRegisteredModelOrAgnes } from '@/lib/ai/model-selection';

/**
 * Selection-based AI editing.
 *
 * The chapter is loaded through `requireChapter`, which joins `novels.userId`,
 * so a chapter id belonging to another account resolves to 404 before any
 * prompt, provider call or usage record happens.
 */
export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  const body = await readJsonBody(req, v => editorActionSchema.parse(v));
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

  const result = await generateTextDetailed({
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0.7,
    maxTokens: 1500,
    userId: user.id,
    novelId: chapter.novelId,
    taskType: `editor:${body.action}`,
    // Interactive editing must never substitute fabricated prose for a real
    // failure — the author is told and can retry.
    allowFallbackOnError: false,
    ...(textModel !== 'auto' ? { model: textModel } : {}),
  });

  return Response.json({
    text: result.text.trim(),
    source: result.meta.source,
    model: result.meta.actualModel ?? result.meta.model,
    fallbackUsed: result.meta.modelFallbackUsed ?? false,
  });
});
