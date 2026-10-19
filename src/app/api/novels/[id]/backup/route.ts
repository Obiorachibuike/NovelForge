import { requireUser, requireNovel } from '@/lib/db/ownership';
import { errorResponse, readJsonBody } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { createNovelBackup, restoreNovelBackup } from '@/services/backups/service';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const novel = await requireNovel(params.id, user.id);
    enforceRateLimit('export', user.id);
    const bundle = await createNovelBackup(user.id, novel.id);
    const url = new URL(req.url);
    if (url.searchParams.get('download') === '1') {
      const slug = (novel.title || 'novel')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'novel';
      const json = JSON.stringify(bundle, null, 2);
      return new Response(json, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${slug}-backup.json"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    return Response.json(bundle);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const novel = await requireNovel(params.id, user.id);
    enforceRateLimit('export', user.id);
    // Allow up to 16 MB for full novel backups including embedded cover SVGs/images
    const body = await readJsonBody(req, v => v, 16 * 1024 * 1024);
    const result = await restoreNovelBackup(user.id, body, { targetNovelId: novel.id });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
