import { requireUser, requireNovel } from '@/lib/db/ownership';
import { saveChapterContent, getChapter, listVersions } from '@/services/chapters/service';
import { MAX_CHAPTER_CONTENT_BYTES } from '@/types';
import { z } from 'zod';
import { apiHandler, readJsonBody, HttpError, MAX_JSON_BYTES } from '@/lib/api/http';

const saveSchema = z.object({
  contentJson: z.object({ type: z.literal('doc'), content: z.array(z.any()) }),
  expectedRevision: z.number().int().min(1).optional(),
  title: z.string().min(1).max(200).optional(),
  createSnapshot: z.boolean().optional(),
  snapshotNote: z.string().max(300).optional(),
});

export const GET = apiHandler(async (_req: Request, ctx: { params: { id: string; chapterId: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  const chapter = await getChapter(ctx.params.id, ctx.params.chapterId);
  if (!chapter) throw new HttpError(404, 'Chapter not found', 'chapter_not_found');
  return Response.json({ ...chapter, versions: await listVersions(ctx.params.chapterId) });
});

export const PATCH = apiHandler(async (req: Request, ctx: { params: { id: string; chapterId: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  const body = await readJsonBody(req, v => saveSchema.parse(v), MAX_JSON_BYTES.document);
  const serialized = JSON.stringify(body.contentJson);
  if (serialized.length > MAX_CHAPTER_CONTENT_BYTES) {
    throw new HttpError(413, 'Chapter content is too large to save.', 'payload_too_large');
  }
  const result = await saveChapterContent(user.id, ctx.params.id, ctx.params.chapterId, body.contentJson, {
    expectedRevision: body.expectedRevision,
    title: body.title,
    createSnapshot: body.createSnapshot,
    snapshotNote: body.snapshotNote,
  });
  return Response.json({ ok: true, ...result });
});
