import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { freshDatabase, seedUser, db } from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { POST as register } from '@/app/api/auth/register/route';
import { registerUser, verifyCredentials, resolveGoogleSignIn, assertAuthConfiguration, normalizeEmail } from '@/services/auth/service';
import { RATE_LIMITS, resetRateLimitsForTests } from '@/lib/security/rate-limit';

const json = (body: unknown) => new Request('http://localhost:3000/api/auth/register', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  freshDatabase();
  resetRateLimitsForTests();
});

describe('registration (separate from login)', () => {
  it('creates an account with a bcrypt hash and no verified email', async () => {
    const res = await register(json({ name: 'Ada', email: 'Ada@Example.com', password: 'correct horse battery' }));
    expect(res.status).toBe(201);
    const row = db().prepare('SELECT * FROM users WHERE email=?').get('ada@example.com') as any;
    expect(row).toBeTruthy();
    expect(row.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(row.passwordHash).not.toContain('correct horse battery');
    expect(row.emailVerified).toBeNull();
  });

  it('rejects a duplicate email with 409 and does not modify the existing account', async () => {
    await registerUser({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' });
    const before = db().prepare('SELECT passwordHash FROM users WHERE email=?').get('ada@example.com') as any;

    const res = await register(json({ name: 'Impostor', email: 'ada@example.com', password: 'another password' }));
    expect(res.status).toBe(409);
    const after = db().prepare('SELECT passwordHash FROM users WHERE email=?').get('ada@example.com') as any;
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(db().prepare('SELECT COUNT(*) AS c FROM users').get()).toEqual({ c: 1 });
  });

  it('rejects weak or oversized passwords', async () => {
    expect((await register(json({ name: 'A', email: 'a@example.com', password: 'short' }))).status).toBe(400);
    expect((await register(json({ name: 'A', email: 'a@example.com', password: 'x'.repeat(200) }))).status).toBe(400);
    expect(db().prepare('SELECT COUNT(*) AS c FROM users').get()).toEqual({ c: 0 });
  });

  it('validates the email shape and normalises case', async () => {
    expect((await register(json({ name: 'A', email: 'not-an-email', password: 'longenoughpassword' }))).status).toBe(400);
    expect(normalizeEmail('  Mixed@Case.COM ')).toBe('mixed@case.com');
  });

  it('rate limits registration attempts per client', async () => {
    const original = RATE_LIMITS.register.limit;
    (RATE_LIMITS as any).register.limit = 2;
    try {
      await register(json({ name: 'A', email: 'a1@example.com', password: 'longenoughpassword' }));
      await register(json({ name: 'B', email: 'b1@example.com', password: 'longenoughpassword' }));
      const third = await register(json({ name: 'C', email: 'c1@example.com', password: 'longenoughpassword' }));
      expect(third.status).toBe(429);
    } finally {
      (RATE_LIMITS as any).register.limit = original;
    }
  });
});

describe('login is login-only', () => {
  it('does not create an account for an unknown email', async () => {
    const user = await verifyCredentials('nobody@example.com', 'some-long-password');
    expect(user).toBeNull();
    expect(db().prepare('SELECT COUNT(*) AS c FROM users').get()).toEqual({ c: 0 });
  });

  it('rejects a wrong password and accepts the right one', async () => {
    const created = await registerUser({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' });
    expect(await verifyCredentials('ada@example.com', 'wrong password')).toBeNull();
    expect(await verifyCredentials('ADA@example.com', 'correct horse battery')).toBeNull();
    db().prepare('UPDATE users SET emailVerified=? WHERE id=?').run(new Date().toISOString(), created.id);
    const ok = await verifyCredentials('ADA@example.com', 'correct horse battery');
    expect(ok?.id).toBe(created.id);
  });

  it('does not reveal whether an OAuth-only account exists', async () => {
    db().prepare('INSERT INTO users (id,name,email,passwordHash,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
      .run('u_google', 'G', 'g@example.com', null, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    expect(await verifyCredentials('g@example.com', 'anything-at-all')).toBeNull();
  });
});

describe('Google account linking is explicit, never implicit', () => {
  it('creates a new account for a first-time Google sign-in', async () => {
    const decision = await resolveGoogleSignIn({ email: 'new@example.com', name: 'New', image: null });
    expect(decision.allow).toBe(true);
    expect('created' in decision && decision.created).toBe(true);
    const row = db().prepare('SELECT emailVerified FROM users WHERE email=?').get('new@example.com') as any;
    expect(row.emailVerified).toBeTruthy();
  });

  it('refuses to attach a Google identity to an unverified password account', async () => {
    const victimEmail = 'victim@example.com';
    seedUser({ email: victimEmail, name: 'Victim' });
    db().prepare('UPDATE users SET passwordHash=? WHERE email=?').run('$2a$10$abcdefghijklmnopqrstuv', victimEmail);

    const decision = await resolveGoogleSignIn({ email: victimEmail, name: 'Attacker', image: null });
    expect(decision.allow).toBe(false);
    // The password hash and display name are untouched: no silent takeover.
    const row = db().prepare('SELECT name, passwordHash FROM users WHERE email=?').get(victimEmail) as any;
    expect(row.name).toBe('Victim');
    expect(row.passwordHash).toBeTruthy();
  });

  it('links when the account was already verified through Google', async () => {
    db().prepare('INSERT INTO users (id,name,email,passwordHash,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
      .run('u_verified', 'Someone', 'linked@example.com', null, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    const decision = await resolveGoogleSignIn({ email: 'linked@example.com', name: 'Someone Updated', image: null });
    expect(decision).toMatchObject({ allow: true, userId: 'u_verified', created: false });
  });
});

describe('AUTH_SECRET validation', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });

  it('refuses to run in production with a placeholder secret', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    delete process.env.NEXT_PHASE;
    process.env.AUTH_SECRET = 'replace-with-a-long-random-secret';
    expect(() => assertAuthConfiguration()).toThrow(/placeholder|too short/i);
  });

  it('refuses to run in production without a secret at all', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    delete process.env.NEXT_PHASE;
    delete process.env.AUTH_SECRET;
    expect(() => assertAuthConfiguration()).toThrow(/AUTH_SECRET is required/);
  });

  it('accepts a strong secret and is skipped during builds', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    process.env.AUTH_SECRET = 'a'.repeat(48);
    expect(() => assertAuthConfiguration()).not.toThrow();
    process.env.NEXT_PHASE = 'phase-production-build';
    process.env.AUTH_SECRET = 'replace-with-a-long-random-secret';
    expect(() => assertAuthConfiguration()).not.toThrow();
  });
});
