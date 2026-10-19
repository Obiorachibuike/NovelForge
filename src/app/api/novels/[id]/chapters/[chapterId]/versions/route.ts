import { requireUser, requireNovel } from '@/lib/db/ownership';
import {
  getChapter,
  listVersions,
  getVersion,
  createVersion,
  restoreVersion,
} from '@/services/chapters/service';
import { z } from 'zod';
import { apiHandler, readJsonBody, HttpError } from '@/lib/api/http';

const versionActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create').default('create'),
    note: z.string().max(300).optional(),
  }),
  z.object({
    action: z.literal('restore'),
    versionId: z.string().min(1).max(64),
  }),
]);

export const GET = apiHandler(async (req: Request, ctx: { params: { id: string; chapterId: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  const chapter = await getChapter(ctx.params.id, ctx.params.chapterId);
  if (!chapter) throw new HttpError(404, 'Chapter not found', 'chapter_not_found');

  const url = new URL(req.url);
  const versionId = url.searchParams.get('versionId');
  if (versionId) {
    const version = await getVersion(user.id, ctx.params.id, ctx.params.chapterId, versionId);
    return Response.json(version);
  }
  return Response.json({ versions: await listVersions(ctx.params.chapterId) });
});

export const POST = apiHandler(async (req: Request, ctx: { params: { id: string; chapterId: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  const raw = await readJsonBody(req, v => {
    const obj = (v && typeof v === 'object') ? { action: 'create', ...(v as Record<string, unknown>) } : { action: 'create' };
    return versionActionSchema.parse(obj);
  });

  if (raw.action === 'restore') {
    const restored = await restoreVersion(user.id, ctx.params.id, ctx.params.chapterId, raw.versionId);
    return Response.json({ ok: true, ...restored, versions: await listVersions(ctx.params.chapterId) });
  }

  const created = await createVersion(user.id, ctx.params.id, ctx.params.chapterId, raw.note, 'manual');
  return Response.json({ ok: true, version: created, versions: await listVersions(ctx.params.chapterId) }, { status: 201 });
});
