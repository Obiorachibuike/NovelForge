import 'server-only';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { nanoid } from 'nanoid';
import bcrypt from 'bcryptjs';
import { getDb } from '@/lib/db';
import {
  isEmailDeliveryConfigured,
  renderPasswordResetEmail,
  renderVerificationEmail,
  sendTransactionalEmail,
  type RenderedEmail,
} from '@/lib/email';
import { normalizeEmail, BCRYPT_ROUNDS } from './service';

/**
 * Email verification, password recovery and one-time passcodes.
 *
 * Every message is delivered through Brevo (see `src/lib/email/brevo.ts`) and
 * carries two independent, single-use secrets:
 *
 * - a random 32-byte **link token**, stored only as SHA-256, valid for one hour;
 * - a six-digit **one-time passcode**, stored only as a bcrypt hash, valid for
 *   ten minutes and destroyed after five failed attempts.
 *
 * Both are held in the same `auth_action_tokens` row so using either one
 * invalidates the other, there is never more than one live action per
 * e-mail/purpose, and a stolen database can neither be used to redeem a link
 * nor cheaply brute-forced offline for a code.
 */

export type AuthAction = 'verify-email' | 'reset-password';

/** How long the e-mailed action link stays valid. */
export const LINK_TTL_MS = 60 * 60 * 1000;
/** How long the e-mailed one-time passcode stays valid. */
export const CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong passcodes tolerated before the action is destroyed. */
export const MAX_CODE_ATTEMPTS = 5;
export const CODE_LENGTH = 6;

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function appName() {
  return process.env.NEXT_PUBLIC_APP_NAME?.trim() || 'NovelForge';
}

/**
 * Six-digit numeric passcode from the CSPRNG. Leading zeros are preserved
 * because the value is stored and compared as a string.
 */
export function generateOneTimeCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

/** Normalises user input: accepts `123 456`, `123-456` and `123456`. */
export function normalizeCode(raw: string): string {
  return String(raw ?? '').replace(/\D/g, '');
}

interface ActionRow {
  id: string;
  userId: string | null;
  email: string;
  tokenHash?: string;
  codeHash?: string | null;
  codeExpiresAt?: string | null;
  expiresAt: string;
  consumedAt?: string | null;
  failedAttempts?: number;
}

function renderMessage(purpose: AuthAction, input: { name?: string | null; url: string; code: string }): RenderedEmail {
  const common = {
    name: input.name,
    url: input.url,
    code: input.code,
    linkMinutes: Math.round(LINK_TTL_MS / 60_000),
    codeMinutes: Math.round(CODE_TTL_MS / 60_000),
    appName: appName(),
  };
  return purpose === 'verify-email' ? renderVerificationEmail(common) : renderPasswordResetEmail(common);
}

async function deliver(to: string, purpose: AuthAction, rendered: RenderedEmail, fallbackDetail: string) {
  if (!isEmailDeliveryConfigured()) {
    if (process.env.NODE_ENV !== 'production') {
      // Development/test fallback: without a delivery provider the user could
      // never receive the link or code, which would strand a fresh account
      // before its first sign-in. Emit the one-time material to the server
      // console instead — never in production, where the operator must
      // configure a real provider.
      console.log(
        `[auth] Email delivery is not configured (BREVO_API_KEY/MAIL_FROM). Development fallback — ${rendered.subject} for ${to}: ${fallbackDetail}`,
      );
      return;
    }
    throw new Error('Email delivery is not configured. Set BREVO_API_KEY and MAIL_FROM.');
  }

  await sendTransactionalEmail({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tags: [`auth-${purpose}`],
  });
}

/**
 * Creates (replacing any previous one) and sends the action e-mail.
 *
 * Returns `false` when there is nothing to send — unknown address, or an
 * already-verified address for `verify-email` — so callers can tell "nothing
 * sent" apart from "delivery failed" (which throws).
 */
export async function createAndSendAuthAction(emailRaw: string, purpose: AuthAction): Promise<boolean> {
  const email = normalizeEmail(emailRaw);
  if (!email) return false;
  const db = getDb();
  const user = db.prepare('SELECT id, name, emailVerified FROM users WHERE email = ?').get(email) as
    | { id: string; name: string | null; emailVerified: string | null }
    | undefined;
  if (!user) return false;
  if (purpose === 'verify-email' && user.emailVerified) return false;

  const token = randomBytes(32).toString('base64url');
  const code = generateOneTimeCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS).toISOString();
  const codeExpiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString();
  const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
  const page = purpose === 'verify-email' ? 'verify-email' : 'reset-password';
  const url = `${appUrl()}/${page}?token=${encodeURIComponent(token)}`;

  const replace = db.transaction(() => {
    db.prepare('DELETE FROM auth_action_tokens WHERE email = ? AND purpose = ?').run(email, purpose);
    db.prepare(
      `INSERT INTO auth_action_tokens
         (id, userId, email, purpose, tokenHash, codeHash, codeExpiresAt, expiresAt, failedAttempts, createdAt, consumedAt)
       VALUES (?,?,?,?,?,?,?,?,0,?,NULL)`,
    ).run(nanoid(), user.id, email, purpose, digest(token), codeHash, codeExpiresAt, expiresAt, now.toISOString());
  });
  replace();

  const rendered = renderMessage(purpose, { name: user.name, url, code });
  await deliver(email, purpose, rendered, `${url} (code ${code})`);
  return true;
}

/** Marks a row consumed exactly once; returns false if somebody else won the race. */
function consumeRow(db: ReturnType<typeof getDb>, id: string, now: string): boolean {
  const result = db
    .prepare('UPDATE auth_action_tokens SET consumedAt = ? WHERE id = ? AND consumedAt IS NULL')
    .run(now, id);
  return result.changes > 0;
}

/**
 * Atomically increments the failed-attempt counter *before* the (comparatively
 * slow) bcrypt comparison, so parallel guessing cannot multiply the allowed
 * attempts. Returns the updated count, or `null` when the row is already spent.
 */
function registerAttempt(db: ReturnType<typeof getDb>, id: string): number | null {
  const result = db
    .prepare(
      'UPDATE auth_action_tokens SET failedAttempts = failedAttempts + 1 WHERE id = ? AND consumedAt IS NULL AND failedAttempts < ?',
    )
    .run(id, MAX_CODE_ATTEMPTS);
  if (!result.changes) return null;
  const row = db.prepare('SELECT failedAttempts FROM auth_action_tokens WHERE id = ?').get(id) as
    | { failedAttempts: number }
    | undefined;
  return row ? Number(row.failedAttempts) : null;
}

/**
 * Finds and validates a passcode, without consuming the action yet (the caller
 * performs the state change and consumption in one transaction).
 *
 * Returns `null` for anything that must look identical to the caller: malformed
 * input, unknown address, expired code, too many attempts, or a wrong code.
 */
async function verifyCodeRow(
  db: ReturnType<typeof getDb>,
  emailRaw: string,
  purpose: AuthAction,
  codeRaw: string,
): Promise<ActionRow | null> {
  const email = normalizeEmail(emailRaw);
  const code = normalizeCode(codeRaw);
  if (!email || code.length !== CODE_LENGTH) return null;

  const row = db
    .prepare(
      `SELECT id, userId, email, codeHash, codeExpiresAt, expiresAt, failedAttempts
         FROM auth_action_tokens
        WHERE email = ? AND purpose = ? AND consumedAt IS NULL AND codeHash IS NOT NULL
        ORDER BY createdAt DESC LIMIT 1`,
    )
    .get(email, purpose) as ActionRow | undefined;
  if (!row) return null;

  const now = new Date().toISOString();
  if (!row.codeExpiresAt || row.codeExpiresAt <= now) {
    // The code half has expired. Keep the row: the link in the same message is
    // still valid for the rest of its hour, and the code can never match again.
    return null;
  }
  if ((row.failedAttempts ?? 0) >= MAX_CODE_ATTEMPTS) {
    // Attempts exhausted: destroy the action so it cannot come back to life.
    consumeRow(db, row.id, now);
    return null;
  }

  const attempts = registerAttempt(db, row.id);
  if (attempts === null) return null;

  const matches = await bcrypt.compare(code, row.codeHash as string);
  if (!matches) {
    if (attempts >= MAX_CODE_ATTEMPTS) consumeRow(db, row.id, new Date().toISOString());
    return null;
  }
  return row;
}

/** Redeems an e-mailed verification link (single use). */
export async function consumeEmailVerification(rawToken: string): Promise<boolean> {
  if (!rawToken || rawToken.length > 200) return false;
  const db = getDb();
  const now = new Date().toISOString();
  const token = db
    .prepare(
      'SELECT id, userId, email FROM auth_action_tokens WHERE tokenHash = ? AND purpose = ? AND consumedAt IS NULL AND expiresAt > ?',
    )
    .get(digest(rawToken), 'verify-email', now) as ActionRow | undefined;
  if (!token) return false;

  const tx = db.transaction(() => {
    if (!consumeRow(db, token.id, now)) return false;
    db.prepare('UPDATE users SET emailVerified = ?, updatedAt = ? WHERE id = ? AND email = ?').run(
      now,
      now,
      token.userId,
      token.email,
    );
    return true;
  });
  return tx();
}

/** Redeems a six-digit verification passcode (single use, attempt limited). */
export async function consumeEmailVerificationCode(emailRaw: string, codeRaw: string): Promise<boolean> {
  const db = getDb();
  const row = await verifyCodeRow(db, emailRaw, 'verify-email', codeRaw);
  if (!row) return false;

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    if (!consumeRow(db, row.id, now)) return false;
    db.prepare('UPDATE users SET emailVerified = ?, updatedAt = ? WHERE id = ? AND email = ?').run(
      now,
      now,
      row.userId,
      row.email,
    );
    return true;
  });
  return tx();
}

/** Redeems an e-mailed reset link and replaces the password (single use). */
export async function consumePasswordReset(rawToken: string, password: string): Promise<boolean> {
  if (!rawToken || rawToken.length > 200 || password.length < 8 || password.length > 72) return false;
  const db = getDb();
  const now = new Date().toISOString();
  const token = db
    .prepare(
      'SELECT id, userId FROM auth_action_tokens WHERE tokenHash = ? AND purpose = ? AND consumedAt IS NULL AND expiresAt > ?',
    )
    .get(digest(rawToken), 'reset-password', now) as ActionRow | undefined;
  if (!token) return false;

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const tx = db.transaction(() => {
    if (!consumeRow(db, token.id, now)) return false;
    db.prepare('UPDATE users SET passwordHash = ?, updatedAt = ? WHERE id = ?').run(hash, now, token.userId);
    return true;
  });
  return tx();
}

/** Redeems a six-digit reset passcode and replaces the password (single use). */
export async function consumePasswordResetCode(
  emailRaw: string,
  codeRaw: string,
  password: string,
): Promise<boolean> {
  if (password.length < 8 || password.length > 72) return false;
  const db = getDb();
  const row = await verifyCodeRow(db, emailRaw, 'reset-password', codeRaw);
  if (!row) return false;

  const now = new Date().toISOString();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const tx = db.transaction(() => {
    if (!consumeRow(db, row.id, now)) return false;
    db.prepare('UPDATE users SET passwordHash = ?, updatedAt = ? WHERE id = ?').run(hash, now, row.userId);
    return true;
  });
  return tx();
}

/**
 * Whether an e-mail/purpose pair has a live action (used by the recovery pages
 * to decide which form to emphasize). Never reveals anything about a specific
 * address beyond "this browser just received a message".
 */
export function hasPendingAction(emailRaw: string, purpose: AuthAction): boolean {
  const email = normalizeEmail(emailRaw);
  if (!email) return false;
  const now = new Date().toISOString();
  return Boolean(
    getDb()
      .prepare(
        'SELECT 1 FROM auth_action_tokens WHERE email = ? AND purpose = ? AND consumedAt IS NULL AND expiresAt > ?',
      )
      .get(email, purpose, now),
  );
}
