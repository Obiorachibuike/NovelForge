import { requireUser, requireNovel } from '@/lib/db/ownership';
import { enqueueChapterGeneration, listChapters, getNavigation } from '@/services/chapters/service';
import { listOutlines } from '@/services/outlines/service';
import { chapterGenerateSchema } from '@/types';
import { apiHandler, readJsonBody, HttpError } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { getDb } from '@/lib/db';

export const GET = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  const url = new URL(req.url);
  if (url.searchParams.get('navigation') === 'true') {
    return Response.json(await getNavigation(ctx.params.id));
  }
  const chapterNumber = url.searchParams.get('chapterNumber');
  let chapters = await listChapters(ctx.params.id);
  if (chapterNumber) {
    const n = Number.parseInt(chapterNumber, 10);
    chapters = chapters.filter((c: any) => c.chapterNumber === n);
  }
  return Response.json(chapters);
});

export const POST = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  enforceRateLimit('aiGeneration', user.id);
  const body = await readJsonBody(req, v => chapterGenerateSchema.parse(v));

  const db = getDb();
  const outlines = listOutlines(ctx.params.id);
  if (!outlines.length) throw new HttpError(409, 'Generate and approve an outline before writing chapters.', 'no_outline');

  let chapterNumber = body.chapterNumber ?? null;
  if (!chapterNumber && body.chapterId) {
    const chapter = db.prepare('SELECT chapterNumber FROM chapters WHERE id=? AND novelId=?').get(body.chapterId, ctx.params.id) as any;
    const outline = chapter ? null : db.prepare('SELECT chapterNumber FROM chapter_outlines WHERE id=? AND novelId=?').get(body.chapterId, ctx.params.id) as any;
    chapterNumber = (chapter || outline)?.chapterNumber ?? null;
  }
  if (!chapterNumber) {
    const navigation = await getNavigation(ctx.params.id);
    chapterNumber = navigation.find(n => n.status !== 'approved')?.chapterNumber ?? null;
  }
  if (!chapterNumber) throw new HttpError(409, 'Every scheduled chapter has already been approved.', 'nothing_to_write');

  const jobId = await enqueueChapterGeneration(user.id, ctx.params.id, chapterNumber, {
    confirmOverwrite: body.confirmOverwrite,
  });
  return Response.json({ jobId, chapterNumber });
});
