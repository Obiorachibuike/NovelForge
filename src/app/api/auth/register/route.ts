import { apiHandler, readJsonBody } from '@/lib/api/http';
import { enforceRateLimit, clientIp } from '@/lib/security/rate-limit';
import { registerUser } from '@/services/auth/service';

/**
 * Account creation, kept separate from sign-in.
 *
 * Rate limited per client IP because it is unauthenticated and does bcrypt work.
 * The response never indicates whether an address is already registered beyond
 * the explicit "already exists" case, which the sign-up form needs to be usable.
 */
export const POST = apiHandler(async (req: Request) => {
  enforceRateLimit('register', clientIp(req));
  const body = await readJsonBody(req, v => v as Record<string, unknown>);
  const user = await registerUser({
    name: String(body?.name ?? '').trim(),
    email: String(body?.email ?? ''),
    password: String(body?.password ?? ''),
  });
  return Response.json({ user }, { status: 201 });
});
