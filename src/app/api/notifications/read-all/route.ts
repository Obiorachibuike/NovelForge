import { requireUser } from '@/lib/db/ownership';
import { apiHandler } from '@/lib/api/http';
import { markAllNotificationsRead, unreadNotificationCount } from '@/lib/jobs/notifications';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/notifications/read-all */
export const POST = apiHandler(async (_req: Request) => {
  const user = await requireUser();
  const updated = markAllNotificationsRead(user.id);
  return Response.json({ ok: true, updated, unreadCount: unreadNotificationCount(user.id) });
});
