import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/db/ownership';
import { apiHandler, HttpError } from '@/lib/api/http';
import { readFile } from '@/lib/storage';

/**
 * Authenticated file delivery for generated covers and exports.
 *
 * Files used to be written into `public/uploads` and served statically, which
 * made every cover and manuscript readable by anyone who guessed (or was sent)
 * the URL. Every object is now resolved through the database, and the caller
 * must own the row that references it.
 */
export const GET = apiHandler(async (_req: Request, ctx: { params: { key: string[] } }) => {
  const user = await requireUser();
  const key = (ctx.params.key || []).join('/');
  if (!key || key.includes('..')) throw new HttpError(400, 'Invalid file key.');

  const db = getDb();
  const asset = db.prepare('SELECT id, userId FROM image_assets WHERE storageKey = ? LIMIT 1').get(key) as any;
  const exported = asset ? null : db.prepare('SELECT id, userId, format FROM exports WHERE fileKey = ? LIMIT 1').get(key) as any;

  const ownerId = asset?.userId ?? exported?.userId;
  if (!ownerId) throw new HttpError(404, 'File not found', 'file_not_found');
  if (ownerId !== user.id) throw new HttpError(404, 'File not found', 'file_not_found');

  const file = await readFile(key);
  if (!file) throw new HttpError(404, 'File not found', 'file_not_found');

  const filename = key.split('/').pop() || 'download';
  const headers: Record<string, string> = {
    'Content-Type': file.contentType,
    'Content-Length': String(file.data.length),
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  };
  if (exported) {
    headers['Content-Disposition'] = `attachment; filename="${filename.replace(/["\\]/g, '')}"`;
  }

  return new Response(new Uint8Array(file.data), { status: 200, headers });
});

/** Range/HEAD are not needed for these small assets; other methods are rejected. */
export const POST = apiHandler(async () => {
  throw new HttpError(405, 'Method not allowed.');
});
