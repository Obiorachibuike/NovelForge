import { requireUser } from '@/lib/db/ownership';
import { apiHandler, HttpError } from '@/lib/api/http';
import { markNotificationRead, unreadNotificationCount } from '@/lib/jobs/notifications';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/notifications/[notificationId] — mark one notification read.
 * The update is scoped by `userId`, so a notification id belonging to another
 * account simply does not match.
 */
export const PATCH = apiHandler(async (_req: Request, ctx: { params: { notificationId: string } }) => {
  const user = await requireUser();
  const updated = markNotificationRead(user.id, ctx.params.notificationId);
  if (!updated) throw new HttpError(404, 'Notification not found', 'notification_not_found');
  return Response.json({ ok: true, unreadCount: unreadNotificationCount(user.id) });
});

/** POST is an alias for clients that only send POST requests. */
export const POST = PATCH;
