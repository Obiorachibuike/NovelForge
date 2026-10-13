import { requireUser, requireNovel } from '@/lib/db/ownership';
import { enqueueExport, listExports } from '@/services/exports/service';
import { exportSchema } from '@/types';
import { apiHandler, readJsonBody, MAX_JSON_BYTES } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';

export const GET = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  return Response.json(listExports(ctx.params.id));
});

export const POST = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  enforceRateLimit('export', user.id);
  const body = await readJsonBody(req, v => exportSchema.parse(v), MAX_JSON_BYTES.export);
  return Response.json({ jobId: await enqueueExport(user.id, ctx.params.id, body.format, body.options) });
});
