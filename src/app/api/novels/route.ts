import { requireUser, jsonError } from '@/lib/db/ownership';
import { createNovel, listNovels } from '@/services/novels/service';
import { assertCanCreateNovel } from '@/services/billing/service';
import { createNovelSchema } from '@/types';
import { apiHandler, readJsonBody } from '@/lib/api/http';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { HttpError } from '@/lib/api/http';

export const GET = apiHandler(async (req?: Request) => {
  const user = await requireUser();
  if (req?.url) {
    const url = new URL(req.url);
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
    const offset = offsetParam ? Number.parseInt(offsetParam, 10) : undefined;
    return Response.json(await listNovels(user.id, { limit, offset }));
  }
  return Response.json(await listNovels(user.id));
});

const CREATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };

export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  // Check the entitlement before the burst limiter: a writer without a plan
  // should be told to pick one, not throttled by a quota they never spent.
  assertCanCreateNovel(user.id);
  const burst = checkRateLimit('aiGeneration', `novel-create:${user.id}`, CREATE_LIMIT);
  if (!burst.ok) throw new HttpError(429, 'Too many novels created in the last hour.', 'rate_limited');
  const data = await readJsonBody(req, v => createNovelSchema.parse(v));
  return Response.json(await createNovel(user.id, data));
});
