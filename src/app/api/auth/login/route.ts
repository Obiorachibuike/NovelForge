import { z } from 'zod';
import { AuthError } from 'next-auth';
import { apiHandler, readJsonBody, HttpError, MAX_JSON_BYTES } from '@/lib/api/http';
import { enforceRateLimit, clientIp } from '@/lib/security/rate-limit';
import { signIn } from '@/lib/auth/config';
import { verifyCredentials } from '@/services/auth/service';

/**
 * Credentials sign-in for API clients: `POST /api/auth/login`.
 *
 * The interactive form on /login drives Auth.js's own
 * `POST /api/auth/callback/credentials` (CSRF token, form encoding). This
 * route is the explicit JSON endpoint for programmatic clients — mobile apps,
 * scripts, integrations. On success it completes the *same* Auth.js flow
 * server-side, so the response carries a real Auth.js session cookie: every
 * cookie-authenticated route (`/api/novels`, `/settings`, …) treats the caller
 * exactly as if they had signed in through the form.
 *
 * Contract:
 * - `{ email, password }` in, `200 { user, emailVerified }` out.
 * - Unknown address and wrong password answer with the identical generic
 *   `401 invalid_credentials` (plus a dummy bcrypt run inside
 *   `verifyCredentials`), so the endpoint cannot be used to enumerate accounts.
 * - An unverified e-mail does **not** block sign-in (the profile page shows
 *   the warning instead); `emailVerified` is returned so API clients can
 *   render the same prompt.
 * - Rate limited per client IP. Body must be JSON, which browsers cannot send
 *   cross-site without a CORS-preflighted request, so no CSRF token is needed
 *   for this endpoint.
 */
const loginSchema = z.object({
  // Same shape rules as registration: an address that could not have been
  // registered can be rejected up front without leaking anything about which
  // accounts exist.
  email: z.string().trim().toLowerCase().email('A valid email address is required').max(254),
  // bcrypt only uses the first 72 bytes; mirrors registerSchema so both ends
  // of the API agree on what a usable password looks like.
  password: z.string().min(8, 'Password must be at least 8 characters.').max(72, 'Password must be at most 72 characters.'),
});

export const POST = apiHandler(async (req: Request) => {
  enforceRateLimit('login', clientIp(req));
  const body = await readJsonBody(req, v => loginSchema.parse(v), MAX_JSON_BYTES.default);

  // Authenticate first: a wrong password never reaches the session machinery,
  // and a database failure during the lookup is classified into the same 503
  // with remediation that every other route returns (see lib/db/errors.ts).
  const user = await verifyCredentials(body.email, body.password);
  if (!user) {
    throw new HttpError(401, 'Invalid email or password.', 'invalid_credentials');
  }

  // Complete the Auth.js credentials flow server-side. `redirect: false`
  // makes the helper return the callback URL instead of throwing a Next.js
  // redirect; Auth.js reports failures as `error=…` query parameters on that
  // URL — the same signal the browser client reads — and on success the
  // helper has already written the session cookie into this response.
  let callbackUrl: string;
  try {
    callbackUrl = String(
      await signIn('credentials', {
        email: body.email,
        password: body.password,
        redirect: false,
        redirectTo: '/',
      }),
    );
  } catch (error) {
    // Configuration problems (missing AUTH_SECRET, …) and unexpected failures
    // inside Auth.js surface as thrown AuthErrors rather than a URL.
    if (error instanceof AuthError) {
      console.error(`[auth] login could not create a session: ${error.message}`);
      throw new HttpError(503, 'Sign-in is temporarily unavailable. Please try again shortly.', 'signin_unavailable');
    }
    throw error;
  }

  const failure = probeUrl(callbackUrl).searchParams.get('error');
  if (failure === 'Configuration') {
    throw new HttpError(
      503,
      'Sign-in is not available: the server is missing required configuration (AUTH_SECRET) or cannot reach its database. Open /api/health for the exact cause.',
      'auth_configuration',
    );
  }
  if (failure) {
    // We already authenticated above, so anything Auth.js reports back (the
    // expected `CredentialsSignin`, or a race where the account changed
    // between the two checks) collapses into the same generic failure.
    console.warn(`[auth] login session rejected by Auth.js: ${failure}`);
    throw new HttpError(401, 'Invalid email or password.', 'invalid_credentials');
  }

  return Response.json({
    user: { id: user.id, name: user.name, email: user.email, image: user.image },
    emailVerified: Boolean(user.emailVerified),
  });
});

/**
 * Parses Auth.js's returned callback URL (absolute in practice; a relative
 * path would mean success and carries no query string either way).
 */
function probeUrl(raw: string): URL {
  try {
    return new URL(raw, 'http://invalid.local');
  } catch {
    return new URL('http://invalid.local/');
  }
}
