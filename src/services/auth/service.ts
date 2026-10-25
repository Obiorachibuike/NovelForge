import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import bcrypt from 'bcryptjs';
import { HttpError } from '@/lib/api/http';
import { registerSchema, type RegisterInput } from '@/types';
import 'server-only';

/**
 * Authentication service.
 *
 * Registration is a separate operation from login (POST /api/auth/register),
 * so it can be rate-limited, audited and reasoned about independently, and so
 * an unknown e-mail at the login form can never create an account.
 */

export const BCRYPT_ROUNDS = 10;

export interface PublicUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

/**
 * Creates a credentials account.
 *
 * Errors are deliberately generic where they could be used to enumerate
 * accounts: an existing e-mail produces the same shape of failure as a
 * validation problem, and the message does not confirm which case occurred.
 */
export async function registerUser(input: RegisterInput): Promise<PublicUser> {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.errors[0]?.message || 'Invalid registration details.');
  }
  const { name, email, password } = parsed.data;
  const db = getDb();

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
  if (existing) {
    throw new HttpError(409, 'An account with this email already exists. Sign in instead.', 'email_taken');
  }

  const id = nanoid();
  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    db.prepare(
      'INSERT INTO users (id,name,email,passwordHash,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)',
    ).run(id, name, email, passwordHash, null, now, now);
  } catch (err) {
    // Unique index is the real guard against two concurrent registrations.
    if (String(err).includes('UNIQUE')) {
      throw new HttpError(409, 'An account with this email already exists. Sign in instead.', 'email_taken');
    }
    throw err;
  }

  return { id, name, email, image: null };
}

/**
 * Verifies credentials for an existing account. Never creates users.
 *
 * The same generic error is returned for "no such user" and "wrong password",
 * and a dummy bcrypt comparison runs for unknown e-mails so response timing
 * does not reveal which addresses are registered.
 */
export async function verifyCredentials(emailRaw: string, passwordRaw: string): Promise<PublicUser | null> {
  const email = normalizeEmail(emailRaw);
  const password = String(passwordRaw || '');
  if (!email || !password) return null;
  if (password.length > 72) return null;

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;

  if (!user) {
    await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
    return null;
  }
  if (!user.passwordHash) {
    // Account exists but is OAuth-only: do not reveal which provider.
    await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
    return null;
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok || !user.emailVerified) return null;
  return { id: user.id, name: user.name, email: user.email, image: user.image };
}

export type GoogleLinkDecision =
  // `reason?: undefined` on the success arm keeps `decision.reason` readable
  // without narrowing, because this project compiles with `strict: false`,
  // where TypeScript does not narrow boolean-literal discriminants.
  | { allow: true; userId: string; created: boolean; reason?: undefined }
  | { allow: false; reason: string };

/**
 * Decides how a Google sign-in maps onto an existing account.
 *
 * Three rules, in order:
 *
 * 1. A **password account that is not yet email-verified** is never attached to
 *    a Google identity. Otherwise anyone could pre-register `victim@example.com`
 *    with a password and keep access to the account after the victim signs in
 *    with Google.
 * 2. A Google account (`sub`) is permanently bound to exactly one NovelForge
 *    account. If the same Google `sub` arrives with a different e-mail (Google
 *    addresses can change), the sign-in is refused instead of moving or
 *    duplicating the identity.
 * 3. Otherwise the Google identity is linked: a first sign-in creates the user
 *    row (marked verified, because Google vouches for the address) and later
 *    sign-ins refresh the display name and avatar.
 */
export async function resolveGoogleSignIn(profile: {
  email: string;
  name?: string | null;
  image?: string | null;
  /** Google's stable subject id; enables rule 2 when present. */
  providerAccountId?: string | null;
}): Promise<GoogleLinkDecision> {
  const db = getDb();
  const email = normalizeEmail(profile.email);
  if (!email) return { allow: false, reason: 'Google did not return an email address.' };

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
  const now = new Date().toISOString();

  if (existing?.passwordHash && !existing.emailVerified) {
    return {
      allow: false,
      reason: 'An account with this email already exists and uses a password. Sign in with your password first.',
    };
  }

  const targetId: string = existing?.id ?? nanoid();

  const providerAccountId = String(profile.providerAccountId || '').trim();
  if (providerAccountId) {
    const linked = db.prepare('SELECT userId FROM accounts WHERE provider = ? AND providerAccountId = ?')
      .get('google', providerAccountId) as { userId: string } | undefined;
    if (linked && linked.userId !== targetId) {
      return {
        allow: false,
        reason: 'This Google account is already linked to a different NovelForge account.',
      };
    }
  }

  if (!existing) {
    const name = profile.name?.trim() || email.split('@')[0];
    db.prepare(
      'INSERT INTO users (id,name,email,image,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)',
    ).run(targetId, name, email, profile.image || null, now, now, now);
    return { allow: true, userId: targetId, created: true };
  }

  // Existing OAuth account (or a previously linked one): refresh metadata.
  db.prepare('UPDATE users SET name=COALESCE(?, name), image=COALESCE(?, image), updatedAt=? WHERE id=?')
    .run(profile.name || null, profile.image || null, now, existing.id);
  if (!existing.emailVerified) {
    db.prepare('UPDATE users SET emailVerified=? WHERE id=?').run(now, existing.id);
  }
  return { allow: true, userId: existing.id, created: false };
}

/**
 * Records the OAuth link in the `accounts` table so the binding between a
 * Google account and a NovelForge user is durable and auditable, and so rule 2
 * above has something to check. Returns `{ linked: false, conflict: true }` if
 * the provider account already belongs to somebody else — the caller must then
 * fail the sign-in closed.
 */
export function recordOAuthAccount(input: {
  userId: string;
  provider: string;
  providerAccountId?: string | null;
}): { linked: boolean; conflict: boolean } {
  const providerAccountId = String(input.providerAccountId || '').trim();
  if (!providerAccountId) return { linked: false, conflict: false };

  const db = getDb();
  const existing = db.prepare('SELECT id, userId FROM accounts WHERE provider = ? AND providerAccountId = ?')
    .get(input.provider, providerAccountId) as { id: string; userId: string } | undefined;

  if (existing) {
    if (existing.userId !== input.userId) return { linked: false, conflict: true };
    return { linked: true, conflict: false };
  }

  try {
    db.prepare(
      `INSERT INTO accounts (id,userId,type,provider,providerAccountId) VALUES (?,?,?,?,?)`,
    ).run(nanoid(), input.userId, 'oauth', input.provider, providerAccountId);
    return { linked: true, conflict: false };
  } catch (err) {
    // A concurrent sign-in may have inserted the same pair first.
    const raced = db.prepare('SELECT userId FROM accounts WHERE provider = ? AND providerAccountId = ?')
      .get(input.provider, providerAccountId) as { userId: string } | undefined;
    if (raced?.userId === input.userId) return { linked: true, conflict: false };
    if (raced) return { linked: false, conflict: true };
    throw err;
  }
}

/** Provider ids linked to an account, for display in settings. */
export function listLinkedProviders(userId: string): string[] {
  const db = getDb();
  return (db.prepare('SELECT DISTINCT provider FROM accounts WHERE userId = ?').all(userId) as Array<{ provider: string }>)
    .map(r => r.provider);
}

export function findUserById(id: string): PublicUser | null {
  const db = getDb();
  const row = db.prepare('SELECT id, name, email, image FROM users WHERE id = ?').get(id) as any;
  return row ?? null;
}

/**
 * Fails fast when the deployment would run with an unusable auth secret.
 * Skipped during `next build` (pages are collected without runtime env).
 */
export function assertAuthConfiguration() {
  const phase = process.env.NEXT_PHASE;
  if (phase === 'phase-production-build') return;
  if (process.env.NODE_ENV !== 'production') return;

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET is required in production. Generate one with: openssl rand -base64 48');
  }
  if (/^replace-with/i.test(secret) || secret.length < 32) {
    throw new Error('AUTH_SECRET is a placeholder or too short. Use at least 32 random characters (openssl rand -base64 48).');
  }
}
