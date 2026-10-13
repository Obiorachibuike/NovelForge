import { requireUser } from '@/lib/db/ownership';
import { listUsersForAdmin, requireAdmin, listAuditLog } from '@/services/billing/service';
import { apiHandler } from '@/lib/api/http';

/** User directory for the admin console. Administrators only. */
export const GET = apiHandler(async (req: Request) => {
  const user = await requireUser();
  requireAdmin(user.id);
  const url = new URL(req.url);
  const query = url.searchParams.get('q') || undefined;
  const limit = Number(url.searchParams.get('limit') || 50);
  return Response.json({
    users: listUsersForAdmin({ query, limit }),
    audit: listAuditLog(25),
  });
});
