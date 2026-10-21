import { requireUser } from '@/lib/db/ownership';
import { apiHandler } from '@/lib/api/http';
import { listUserJobs } from '@/lib/queue';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });

/**
 * The caller's own generation jobs, including which model was requested and
 * which model actually produced the output. Only the owner's rows are returned.
 */
export const GET = apiHandler(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  const limit = parsed.success ? (parsed.data.limit ?? 25) : 25;
  const jobs = (await listUserJobs(user.id, { limit })).map(job => ({
    id: job.id,
    novelId: job.novelId,
    chapterId: job.chapterId ?? null,
    taskType: job.taskType,
    status: job.status,
    progress: job.progress ?? 0,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    requestedModel: (job as any).requestedModel ?? null,
    actualModel: (job as any).actualModel ?? null,
    provider: (job as any).provider ?? null,
    fallbackCount: (job as any).fallbackCount ?? 0,
    durationMs: (job as any).durationMs ?? null,
    error: job.error ? String(job.error).slice(0, 400) : null,
    errorCode: job.errorCode ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  }));
  return Response.json({ jobs, count: jobs.length });
});
