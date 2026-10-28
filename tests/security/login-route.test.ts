import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDatabase } from '../helpers/db';

/**
 * The route completes the real Auth.js flow through `signIn`, but next-auth's
 * server helper reads Next.js request cookies, which do not exist when a route
 * handler is invoked directly in tests. The session cookie itself is asserted
 * in the live end-to-end pass; here the helper is stubbed and its returned
 * callback URL drives the success/failure mapping.
 */
const mocks = vi.hoisted(() => ({
  signIn: vi.fn(async (_provider: string, _options?: unknown) => 'http://localhost:3000/'),
}));

vi.mock('@/lib/auth/config', () => ({
  auth: async () => null,
  handlers: {},
  signIn: mocks.signIn,
  signOut: async () => {},
}));

import { POST as login } from '@/app/api/auth/login/route';
import { registerUser } from '@/services/auth/service';
import { RATE_LIMITS, resetRateLimitsForTests } from '@/lib/security/rate-limit';
import { AuthError } from 'next-auth';

const post = (body: unknown) =>
  new Request('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const INVALID = { error: 'Invalid email or password.', code: 'invalid_credentials' };

beforeEach(() => {
  freshDatabase();
  resetRateLimitsForTests();
  mocks.signIn.mockReset();
  mocks.signIn.mockResolvedValue('http://localhost:3000/');
});

describe('POST /api/auth/login', () => {
  it('rejects a malformed body with 400 before touching credentials', async () => {
    const res = await login(post({ password: 'longenoughpassword' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('validation_failed');
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('answers an unknown email and a wrong password with the same generic 401', async () => {
    await registerUser({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' });

    const unknown = await login(post({ email: 'nobody@example.com', password: 'correct horse battery' }));
    const wrongPassword = await login(post({ email: 'ada@example.com', password: 'totally wrong pass' }));

    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(INVALID);
    expect(wrongPassword.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(INVALID);
    // A rejected attempt never reaches the session machinery.
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('signs in with correct credentials even before the email is verified', async () => {
    const created = await registerUser({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' });

    const res = await login(post({ email: 'ADA@Example.com', password: 'correct horse battery' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user).toMatchObject({ id: created.id, email: 'ada@example.com' });
    expect(data.emailVerified).toBe(false);

    // The session is created through the Auth.js credentials flow, without a
    // CSRF token (server-side call) and without redirecting.
    expect(mocks.signIn).toHaveBeenCalledTimes(1);
    const [provider, options] = mocks.signIn.mock.calls[0];
    expect(provider).toBe('credentials');
    expect(options).toMatchObject({
      email: 'ada@example.com',
      password: 'correct horse battery',
      redirect: false,
    });
  });

  it('reports emailVerified=true once the address has been verified', async () => {
    await registerUser({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' });
    const { db } = await import('../helpers/db');
    db().prepare('UPDATE users SET emailVerified=? WHERE email=?').run(new Date().toISOString(), 'ada@example.com');

    const res = await login(post({ email: 'ada@example.com', password: 'correct horse battery' }));
    expect(res.status).toBe(200);
    expect((await res.json()).emailVerified).toBe(true);
  });

  it('maps an Auth.js CredentialsSignin callback to the same generic 401', async () => {
    await registerUser({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' });
    mocks.signIn.mockResolvedValue('http://localhost:3000/login?error=CredentialsSignin&code=credentials');

    const res = await login(post({ email: 'ada@example.com', password: 'correct horse battery' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID);
  });

  it('reports a Configuration failure as 503 with the remediation', async () => {
    await registerUser({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' });
    mocks.signIn.mockResolvedValue('http://localhost:3000/login?error=Configuration');

    const res = await login(post({ email: 'ada@example.com', password: 'correct horse battery' }));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.code).toBe('auth_configuration');
    expect(data.error).toMatch(/AUTH_SECRET/);
  });

  it('answers a thrown AuthError from the session helper with a retryable 503', async () => {
    await registerUser({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' });
    mocks.signIn.mockRejectedValue(new AuthError('session helper exploded'));

    const res = await login(post({ email: 'ada@example.com', password: 'correct horse battery' }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('signin_unavailable');
  });

  it('rate limits sign-in attempts per client IP', async () => {
    const original = RATE_LIMITS.login.limit;
    (RATE_LIMITS as any).login.limit = 2;
    try {
      const attempt = () => login(post({ email: 'nobody@example.com', password: 'correct horse battery' }));
      expect((await attempt()).status).toBe(401);
      expect((await attempt()).status).toBe(401);
      const third = await attempt();
      expect(third.status).toBe(429);
      expect((await third.json()).code).toBe('rate_limited');
    } finally {
      (RATE_LIMITS as any).login.limit = original;
    }
  });
});
