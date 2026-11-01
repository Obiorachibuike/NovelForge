import { requireUser } from '@/lib/db/ownership';
import { apiHandler, HttpError } from '@/lib/api/http';
import {
  listNotifications,
  serializeNotification,
  unreadNotificationCount,
} from '@/lib/jobs/notifications';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  unreadOnly: z.enum(['true', 'false', '1', '0']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** GET /api/notifications — the caller's notification centre. */
export const GET = apiHandler(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.errors[0]?.message || 'Invalid query', 'validation_failed');
  }
  const unreadOnly = parsed.data.unreadOnly === 'true' || parsed.data.unreadOnly === '1';
  const rows = listNotifications(user.id, {
    unreadOnly,
    limit: parsed.data.limit ?? 30,
  });
  return Response.json(
    {
      notifications: rows.map(serializeNotification),
      unreadCount: unreadNotificationCount(user.id),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
