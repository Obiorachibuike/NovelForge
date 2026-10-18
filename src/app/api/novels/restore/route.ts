import { requireUser } from '@/lib/db/ownership';
import { errorResponse, readJsonBody } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { restoreNovelBackup } from '@/services/backups/service';

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    enforceRateLimit('export', user.id);
    const body = await readJsonBody<any>(req, v => v, 16 * 1024 * 1024);
    const bundle = body?.bundle ?? body;
    const targetNovelId = typeof body?.targetNovelId === 'string' ? body.targetNovelId : undefined;
    const result = await restoreNovelBackup(user.id, bundle, { targetNovelId });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
