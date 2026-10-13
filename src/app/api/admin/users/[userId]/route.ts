import { requireUser } from '@/lib/db/ownership';
import { updateUserPrivileges } from '@/services/billing/service';
import { adminUserPatchSchema } from '@/types';
import { apiHandler, readJsonBody } from '@/lib/api/http';

/**
 * Grants or revokes privileges for another account: administrator role, or free
 * novel creation without a subscription. Every change is written to the audit
 * log, and the caller cannot demote themselves or remove the last administrator.
 */
export const PATCH = apiHandler(async (req: Request, ctx: { params: { userId: string } }) => {
  const user = await requireUser();
  const body = await readJsonBody(req, v => adminUserPatchSchema.parse(v));
  return Response.json(await updateUserPrivileges(user.id, ctx.params.userId, body));
});
