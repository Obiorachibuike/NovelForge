import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, freshDatabase, seedUser } from '../helpers/db';

import { googleAuthStatus, googleSignInEnabled, googleCallbackUrl } from '@/lib/auth/providers';
import {
  resolveGoogleSignIn, recordOAuthAccount, listLinkedProviders, verifyCredentials, registerUser,
} from '@/services/auth/service';
import { authConfig } from '@/lib/auth/config';

const ENV = { ...process.env };
beforeEach(() => {
  freshDatabase();
  process.env = { ...ENV };
  delete process.env.AUTH_GOOGLE_ID;
  delete process.env.AUTH_GOOGLE_SECRET;
});
afterEach(() => { process.env = { ...ENV }; vi.resetModules(); });

const googleProfile = (overrides: Record<string, unknown> = {}) => ({
  sub: 'google-sub-1',
  email: 'reader@example.com',
  email_verified: true,
  name: 'Reader',
  picture: 'https://example.com/avatar.png',
  ...overrides,
});

/** Invokes the NextAuth callbacks the way the framework does. */
function callSignIn(profile: any = googleProfile(), account: any = { provider: 'google', providerAccountId: 'google-sub-1' }) {
  return (authConfig.callbacks as any).signIn({ user: { name: profile.name, email: profile.email, image: profile.picture }, account, profile });
}
function callJwt(args: any) {
  return (authConfig.callbacks as any).jwt({ token: {}, account: undefined, profile: undefined, user: undefined, ...args });
}

describe('provider configuration', () => {
  it('is enabled only when both credentials are present', () => {
    expect(googleSignInEnabled()).toBe(false);
    expect(googleAuthStatus().problem).toBeNull();

    process.env.AUTH_GOOGLE_ID = 'client-id';
    expect(googleSignInEnabled()).toBe(false);
    expect(googleAuthStatus().problem).toMatch(/AUTH_GOOGLE_SECRET is missing/);

    process.env.AUTH_GOOGLE_SECRET = 'client-secret';
    expect(googleSignInEnabled()).toBe(true);
    expect(googleAuthStatus().problem).toBeNull();

    delete process.env.AUTH_GOOGLE_ID;
    expect(googleAuthStatus().problem).toMatch(/AUTH_GOOGLE_ID is missing/);
  });

  it('registers the Google provider with NextAuth only when configured', async () => {
    vi.resetModules();
    const withoutGoogle = (await import('@/lib/auth/config')).authConfig;
    expect(withoutGoogle.providers.map((p: any) => p.id)).toEqual(['credentials']);

    process.env.AUTH_GOOGLE_ID = 'client-id';
    process.env.AUTH_GOOGLE_SECRET = 'client-secret';
    vi.resetModules();
    const withGoogle = (await import('@/lib/auth/config')).authConfig;
    const ids = withGoogle.providers.map((p: any) => p.id);
    expect(ids).toContain('google');
    expect(ids).toContain('credentials');
  });

  it('reports the redirect URI Google must be told about', () => {
    expect(googleCallbackUrl('https://novel-forge-seven.vercel.app/')).toBe(
      'https://novel-forge-seven.vercel.app/api/auth/callback/google',
    );
    expect(googleCallbackUrl('http://localhost:3000')).toBe('http://localhost:3000/api/auth/callback/google');
  });
});

describe('first Google sign-in', () => {
  it('creates a verified account and returns the user id', async () => {
    const decision = await resolveGoogleSignIn({
      email: 'New@Example.com', name: 'New Writer', image: null, providerAccountId: 'sub-new',
    });
    expect(decision.allow).toBe(true);
    if (!decision.allow) return;
    expect(decision.created).toBe(true);

    const row = db().prepare('SELECT * FROM users WHERE email=?').get('new@example.com') as any;
    expect(row.name).toBe('New Writer');
    expect(row.emailVerified).toBeTruthy();
    expect(row.passwordHash).toBeNull();
  });

  it('issues a session token and records the OAuth link', async () => {
    expect(await callSignIn()).toBe(true);

    const token: any = await callJwt({
      token: {},
      account: { provider: 'google', providerAccountId: 'google-sub-1' },
      profile: googleProfile(),
    });

    const user = db().prepare('SELECT id FROM users WHERE email=?').get('reader@example.com') as any;
    expect(token.id).toBe(user.id);
    const link = db().prepare('SELECT * FROM accounts WHERE provider=? AND providerAccountId=?').get('google', 'google-sub-1') as any;
    expect(link.userId).toBe(user.id);
    expect(link.type).toBe('oauth');
  });

  it('refreshes the name and avatar on later sign-ins without creating a second account', async () => {
    const first = await resolveGoogleSignIn({ email: 'reader@example.com', name: 'Old Name', providerAccountId: 'google-sub-1' });
    const second = await resolveGoogleSignIn({ email: 'reader@example.com', name: 'New Name', image: 'https://example.com/new.png', providerAccountId: 'google-sub-1' });
    expect(second.allow).toBe(true);
    if (!second.allow) return;
    expect(second.created).toBe(false);
    expect(second.userId).toBe((first as any).userId);
    const row = db().prepare('SELECT name, image FROM users WHERE email=?').get('reader@example.com') as any;
    expect(row.name).toBe('New Name');
    expect(row.image).toBe('https://example.com/new.png');
    expect(db().prepare('SELECT COUNT(*) AS c FROM users').get()).toEqual({ c: 1 });
  });
});

describe('account-linking policy', () => {
  it('refuses to attach Google to an unverified password account (takeover attempt)', async () => {
    await registerUser({ name: 'Victim', email: 'victim@example.com', password: 'correct horse battery' });
    const before = db().prepare('SELECT passwordHash, name, emailVerified FROM users WHERE email=?').get('victim@example.com') as any;

    expect(await callSignIn(googleProfile({ sub: 'attacker-sub', email: 'victim@example.com', name: 'Attacker' }))).toBe(false);

    const after = db().prepare('SELECT passwordHash, name, emailVerified FROM users WHERE email=?').get('victim@example.com') as any;
    expect(after).toEqual(before);
    expect(db().prepare('SELECT COUNT(*) AS c FROM accounts').get()).toEqual({ c: 0 });
  });

  it('links to a password account that has already verified its email', async () => {
    await registerUser({ name: 'Verified', email: 'verified@example.com', password: 'correct horse battery' });
    db().prepare('UPDATE users SET emailVerified=? WHERE email=?').run(new Date().toISOString(), 'verified@example.com');

    const decision = await resolveGoogleSignIn({ email: 'verified@example.com', providerAccountId: 'sub-verified' });
    expect(decision.allow).toBe(true);
    if (!decision.allow) return;
    expect(decision.created).toBe(false);

    // The password still works: linking adds a provider, it does not replace one.
    const stillPassword = await verifyCredentials('verified@example.com', 'correct horse battery');
    expect(stillPassword).not.toBeNull();
    expect(stillPassword!.id).toBe(decision.userId);
  });

  it('refuses a Google account already bound to a different user', async () => {
    const owner = seedUser({ email: 'owner@example.com', name: 'Owner' });
    db().prepare('UPDATE users SET emailVerified=? WHERE id=?').run(new Date().toISOString(), owner.id);
    expect(recordOAuthAccount({ userId: owner.id, provider: 'google', providerAccountId: 'sub-shared' })).toEqual({ linked: true, conflict: false });

    // Same Google `sub`, now reporting somebody else's address.
    const decision = await resolveGoogleSignIn({ email: 'someone-else@example.com', providerAccountId: 'sub-shared' });
    expect(decision.allow).toBe(false);
    if (decision.allow) return;
    expect(decision.reason).toMatch(/already linked to a different/i);
    expect(db().prepare('SELECT COUNT(*) AS c FROM users WHERE email=?').get('someone-else@example.com')).toEqual({ c: 0 });
  });

  it('fails the session closed if the link conflicts at token time', async () => {
    const other = seedUser({ email: 'other@example.com', name: 'Other' });
    db().prepare('UPDATE users SET emailVerified=? WHERE id=?').run(new Date().toISOString(), other.id);
    recordOAuthAccount({ userId: other.id, provider: 'google', providerAccountId: 'google-sub-1' });

    // A user with a different address somehow holds the same Google subject.
    const token: any = await callJwt({
      token: { id: 'pre-existing' },
      account: { provider: 'google', providerAccountId: 'google-sub-1' },
      profile: googleProfile({ email: 'reader@example.com' }),
    });
    expect(token.id).toBeUndefined();
    expect(db().prepare('SELECT COUNT(*) AS c FROM users WHERE email=?').get('reader@example.com')).toEqual({ c: 0 });
  });

  it('refuses a Google profile whose address Google reports as unverified', async () => {
    expect(await callSignIn(googleProfile({ email_verified: false }))).toBe(false);
    expect(db().prepare('SELECT COUNT(*) AS c FROM users').get()).toEqual({ c: 0 });
  });

  it('refuses a Google profile with no email at all', async () => {
    expect(await callSignIn(googleProfile({ email: undefined }))).toBe(false);
    expect(db().prepare('SELECT COUNT(*) AS c FROM users').get()).toEqual({ c: 0 });
  });

  it('leaves credential sign-ins untouched', async () => {
    const signInCallback = (authConfig.callbacks as any).signIn;
    expect(await signInCallback({ user: { id: 'u' }, account: { provider: 'credentials' }, profile: undefined })).toBe(true);
  });
});

describe('OAuth link records', () => {
  it('is idempotent and never moves a link between users', async () => {
    const a = seedUser({ name: 'A' });
    const b = seedUser({ name: 'B' });

    expect(recordOAuthAccount({ userId: a.id, provider: 'google', providerAccountId: 'sub-1' })).toEqual({ linked: true, conflict: false });
    expect(recordOAuthAccount({ userId: a.id, provider: 'google', providerAccountId: 'sub-1' })).toEqual({ linked: true, conflict: false });
    expect(db().prepare('SELECT COUNT(*) AS c FROM accounts').get()).toEqual({ c: 1 });

    expect(recordOAuthAccount({ userId: b.id, provider: 'google', providerAccountId: 'sub-1' })).toEqual({ linked: false, conflict: true });
    expect((db().prepare('SELECT userId FROM accounts WHERE providerAccountId=?').get('sub-1') as any).userId).toBe(a.id);
  });

  it('ignores a missing provider account id instead of creating an unusable link', () => {
    const user = seedUser();
    expect(recordOAuthAccount({ userId: user.id, provider: 'google', providerAccountId: null })).toEqual({ linked: false, conflict: false });
    expect(db().prepare('SELECT COUNT(*) AS c FROM accounts').get()).toEqual({ c: 0 });
  });

  it('lists the providers linked to an account', () => {
    const user = seedUser();
    expect(listLinkedProviders(user.id)).toEqual([]);
    recordOAuthAccount({ userId: user.id, provider: 'google', providerAccountId: 'sub-list' });
    expect(listLinkedProviders(user.id)).toEqual(['google']);
  });
});
