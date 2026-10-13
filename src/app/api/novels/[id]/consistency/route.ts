import { requireUser, requireNovel } from '@/lib/db/ownership';
import { enqueueConsistencyCheck, resolveIssue, listIssues } from '@/services/consistency/service';
import { z } from 'zod';
import { apiHandler, readJsonBody } from '@/lib/api/http';
import { enforceRateLimit } from '@/lib/security/rate-limit';

const resolveSchema = z.object({ issueId: z.string().min(1).max(64), status: z.enum(['resolved', 'ignored']) });

export const GET = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  return Response.json(listIssues(ctx.params.id));
});

export const POST = apiHandler(async (_req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  enforceRateLimit('aiGeneration', user.id);
  return Response.json({ jobId: await enqueueConsistencyCheck(user.id, ctx.params.id) });
});

export const PATCH = apiHandler(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser();
  await requireNovel(ctx.params.id, user.id);
  const body = await readJsonBody(req, v => resolveSchema.parse(v));
  await resolveIssue(user.id, ctx.params.id, body.issueId, body.status);
  return Response.json({ ok: true });
});
