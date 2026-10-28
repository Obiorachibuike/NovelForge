import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { freshDatabase, db } from '../helpers/db';
import { registerUser, verifyCredentials } from '@/services/auth/service';
import {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  createAndSendAuthAction,
  consumeEmailVerification,
  consumeEmailVerificationCode,
  consumePasswordReset,
  consumePasswordResetCode,
  generateOneTimeCode,
  normalizeCode,
} from '@/services/auth/email-actions';
import { BREVO_API_URL } from '@/lib/email';
import { POST as verifyEmailRoute } from '@/app/api/auth/verify-email/route';
import { POST as resetPasswordRoute } from '@/app/api/auth/reset-password/route';
import { resetRateLimitsForTests } from '@/lib/security/rate-limit';

interface SentMessage {
  url: string;
  apiKey: string;
  to: Array<{ email: string; name?: string }>;
  subject: string;
  html: string;
  text: string;
  tags?: string[];
}

let sent: SentMessage[] = [];

/** Captures every outgoing Brevo request; no network access is involved. */
function captureDelivery(status = 201): void {
  sent = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({
      url: String(url),
      apiKey: init.headers['api-key'],
      to: body.to,
      subject: body.subject,
      html: body.htmlContent,
      text: body.textContent,
      tags: body.tags,
    });
    return status === 201
      ? Response.json({ messageId: `mid-${sent.length}` }, { status: 201 })
      : Response.json({ message: 'provider unavailable' }, { status });
  }) as any;
}

const tokenFrom = (message: SentMessage) =>
  message.html.match(/https:\/\/novelforge\.example\/(?:verify-email|reset-password)\?token=([^&<>"]+)/)?.[1];
const codeFrom = (message: SentMessage) =>
  message.text.match(/one-time code: (\d{6})/)?.[1];

const savedEnv = {
  key: process.env.BREVO_API_KEY,
  from: process.env.MAIL_FROM,
  url: process.env.NEXT_PUBLIC_APP_URL,
  fetch: globalThis.fetch,
};

beforeEach(async () => {
  freshDatabase();
  resetRateLimitsForTests();
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  process.env.MAIL_FROM = 'NovelForge <test@example.com>';
  process.env.NEXT_PUBLIC_APP_URL = 'https://novelforge.example';
  process.env.NEXT_PUBLIC_APP_NAME = 'NovelForge';
  captureDelivery();
  await registerUser({ name: 'Ada', email: 'ada@example.com', password: 'old password 123' });
});

afterEach(() => {
  process.env.BREVO_API_KEY = savedEnv.key;
  process.env.MAIL_FROM = savedEnv.from;
  process.env.NEXT_PUBLIC_APP_URL = savedEnv.url;
  globalThis.fetch = savedEnv.fetch;
  vi.restoreAllMocks();
});

describe('verification email through Brevo', () => {
  it('sends one Brevo message carrying both a link and a one-time code', async () => {
    expect(await createAndSendAuthAction('ada@example.com', 'verify-email')).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(BREVO_API_URL);
    expect(sent[0].apiKey).toBe('xkeysib-test-key');
    expect(sent[0].to[0]).toMatchObject({ email: 'ada@example.com' });
    expect(sent[0].tags).toEqual(['auth-verify-email']);
    expect(tokenFrom(sent[0])).toBeTruthy();
    expect(codeFrom(sent[0])).toMatch(/^\d{6}$/);
    // The API key never appears in the message itself.
    expect(sent[0].html).not.toContain('xkeysib-test-key');
  });

  it('emails a one-time verification link and accepts it once', async () => {
    await createAndSendAuthAction('ada@example.com', 'verify-email');
    const token = decodeURIComponent(tokenFrom(sent[0]) as string);

    // Sign-in works before verification — the account is merely flagged.
    const before = await verifyCredentials('ada@example.com', 'old password 123');
    expect(before?.email).toBe('ada@example.com');
    expect(before?.emailVerified ?? null).toBeNull();

    expect(await consumeEmailVerification(token)).toBe(true);
    expect(await consumeEmailVerification(token)).toBe(false);
    const after = await verifyCredentials('ada@example.com', 'old password 123');
    expect(after?.email).toBe('ada@example.com');
    expect(after?.emailVerified).toBeTruthy();
  });

  it('accepts the six-digit code once, and the code dies with the link', async () => {
    await createAndSendAuthAction('ada@example.com', 'verify-email');
    const code = codeFrom(sent[0]) as string;

    expect(await consumeEmailVerificationCode('ada@example.com', code)).toBe(true);
    expect((await verifyCredentials('ada@example.com', 'old password 123'))?.email).toBe('ada@example.com');
    // Re-using the same code (or the link from that message) is refused.
    expect(await consumeEmailVerificationCode('ada@example.com', code)).toBe(false);
    expect(await consumeEmailVerification(decodeURIComponent(tokenFrom(sent[0]) as string))).toBe(false);
  });

  it('accepts a spaced or hyphenated code and rejects a wrong one', async () => {
    await createAndSendAuthAction('ada@example.com', 'verify-email');
    const code = codeFrom(sent[0]) as string;
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

    expect(await consumeEmailVerificationCode('ada@example.com', '000000' === code ? '111111' : '000000')).toBe(false);
    expect(await consumeEmailVerificationCode('ada@example.com', spaced)).toBe(true);
  });

  it('destroys the action after the attempt limit so guessing cannot continue', async () => {
    await createAndSendAuthAction('ada@example.com', 'verify-email');
    const code = codeFrom(sent[0]) as string;
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      expect(await consumeEmailVerificationCode('ada@example.com', wrong)).toBe(false);
    }
    // Even the correct code is useless now…
    expect(await consumeEmailVerificationCode('ada@example.com', code)).toBe(false);
    // …and the leftover row is marked consumed, not merely retried.
    const row = db().prepare('SELECT consumedAt FROM auth_action_tokens WHERE email=?').get('ada@example.com') as any;
    expect(row.consumedAt).toBeTruthy();
  });

  it('refuses a code after it expires even though the link is still valid', async () => {
    await createAndSendAuthAction('ada@example.com', 'verify-email');
    const code = codeFrom(sent[0]) as string;
    const past = new Date(Date.now() - CODE_TTL_MS - 1000).toISOString();
    db().prepare('UPDATE auth_action_tokens SET codeExpiresAt=? WHERE email=?').run(past, 'ada@example.com');

    expect(await consumeEmailVerificationCode('ada@example.com', code)).toBe(false);
    expect(await consumeEmailVerification(decodeURIComponent(tokenFrom(sent[0]) as string))).toBe(true);
  });

  it('replaces the previous message so only the newest code works', async () => {
    await createAndSendAuthAction('ada@example.com', 'verify-email');
    const firstCode = codeFrom(sent[0]) as string;
    await createAndSendAuthAction('ada@example.com', 'verify-email');
    const secondCode = codeFrom(sent[1]) as string;
    expect(sent).toHaveLength(2);
    if (firstCode !== secondCode) {
      expect(await consumeEmailVerificationCode('ada@example.com', firstCode)).toBe(false);
    }
    expect(await consumeEmailVerificationCode('ada@example.com', secondCode)).toBe(true);
  });

  it('sends nothing for an unknown account or an already-verified address', async () => {
    expect(await createAndSendAuthAction('nobody@example.com', 'verify-email')).toBe(false);
    db().prepare('UPDATE users SET emailVerified=? WHERE email=?').run(new Date().toISOString(), 'ada@example.com');
    expect(await createAndSendAuthAction('ada@example.com', 'verify-email')).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('surfaces a provider failure instead of pretending the message was sent', async () => {
    captureDelivery(401);
    await expect(createAndSendAuthAction('ada@example.com', 'verify-email')).rejects.toThrow(/HTTP 401/);
  });

  it('falls back to the console (not a crash) in development without a Brevo key', async () => {
    delete process.env.BREVO_API_KEY;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await createAndSendAuthAction('ada@example.com', 'verify-email')).toBe(true);
    expect(sent).toHaveLength(0);
    const written = log.mock.calls.map(call => call.join(' ')).join('\n');
    expect(written).toContain('verify-email?token=');
    expect(written).toMatch(/code \d{6}/);
  });
});

describe('password recovery through Brevo', () => {
  it('uses a single-use reset link, replaces the password and rejects reuse', async () => {
    db().prepare('UPDATE users SET emailVerified=? WHERE email=?').run(new Date().toISOString(), 'ada@example.com');
    await createAndSendAuthAction('ada@example.com', 'reset-password');
    const token = decodeURIComponent(tokenFrom(sent[0]) as string);

    expect(sent[0].subject).toContain('password reset code');
    expect(await consumePasswordReset(token, 'new password 456')).toBe(true);
    expect(await consumePasswordReset(token, 'another password')).toBe(false);
    expect(await verifyCredentials('ada@example.com', 'old password 123')).toBeNull();
    expect((await verifyCredentials('ada@example.com', 'new password 456'))?.email).toBe('ada@example.com');
  });

  it('resets the password with the e-mailed code', async () => {
    db().prepare('UPDATE users SET emailVerified=? WHERE email=?').run(new Date().toISOString(), 'ada@example.com');
    await createAndSendAuthAction('ada@example.com', 'reset-password');
    const code = codeFrom(sent[0]) as string;

    expect(await consumePasswordResetCode('ada@example.com', code, 'short')).toBe(false);
    expect(await consumePasswordResetCode('ada@example.com', code, 'new password 789')).toBe(true);
    expect(await consumePasswordResetCode('ada@example.com', code, 'another password')).toBe(false);
    expect((await verifyCredentials('ada@example.com', 'new password 789'))?.email).toBe('ada@example.com');
    expect(await verifyCredentials('ada@example.com', 'old password 123')).toBeNull();
    // The link from the same message is spent as well.
    expect(await consumePasswordReset(decodeURIComponent(tokenFrom(sent[0]) as string), 'another password')).toBe(false);
  });

  it('does not create mail/token material for a missing account', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    expect(await createAndSendAuthAction('nobody@example.com', 'reset-password')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('code helpers', () => {
  it('generates six digits including leading zeros and normalises pasted input', () => {
    const code = generateOneTimeCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(normalizeCode(' 123 456 ')).toBe('123456');
    expect(normalizeCode('123-456')).toBe('123456');
    expect(normalizeCode('12a3')).toBe('123');
    const seen = new Set(Array.from({ length: 50 }, () => generateOneTimeCode()));
    expect(seen.size).toBeGreaterThan(40);
  });
});

describe('HTTP routes', () => {
  const post = (path: string, body: unknown) =>
    new Request(`http://localhost:3000${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('verifies with a code over HTTP and rejects a reused code', async () => {
    await createAndSendAuthAction('ada@example.com', 'verify-email');
    const code = codeFrom(sent[0]) as string;

    const first = await verifyEmailRoute(post('/api/auth/verify-email', { email: 'ada@example.com', code }));
    expect(first.status).toBe(200);
    expect((await first.json()).method).toBe('code');

    const second = await verifyEmailRoute(post('/api/auth/verify-email', { email: 'ada@example.com', code }));
    expect(second.status).toBe(400);
    expect((await second.json()).code).toBe('invalid_verification_code');
  });

  it('verifies with a link token over HTTP', async () => {
    await createAndSendAuthAction('ada@example.com', 'verify-email');
    const token = decodeURIComponent(tokenFrom(sent[0]) as string);
    const response = await verifyEmailRoute(post('/api/auth/verify-email', { token }));
    expect(response.status).toBe(200);
    expect((await response.json()).method).toBe('link');
  });

  it('resets a password with email + code over HTTP and validates the password', async () => {
    db().prepare('UPDATE users SET emailVerified=? WHERE email=?').run(new Date().toISOString(), 'ada@example.com');
    await createAndSendAuthAction('ada@example.com', 'reset-password');
    const code = codeFrom(sent[0]) as string;

    const weak = await resetPasswordRoute(
      post('/api/auth/reset-password', { email: 'ada@example.com', code, password: 'short' }),
    );
    expect(weak.status).toBe(400);

    const ok = await resetPasswordRoute(
      post('/api/auth/reset-password', { email: 'ada@example.com', code, password: 'a good new password' }),
    );
    expect(ok.status).toBe(200);
    expect((await verifyCredentials('ada@example.com', 'a good new password'))?.email).toBe('ada@example.com');
  });

  it('rejects a badly formatted code with a 400 and a helpful message', async () => {
    const response = await verifyEmailRoute(post('/api/auth/verify-email', { email: 'ada@example.com', code: '12' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/6-digit code/);
  });

  it('rate limits code submissions per client IP', async () => {
    resetRateLimitsForTests();
    const { RATE_LIMITS } = await import('@/lib/security/rate-limit');
    let last: Response | null = null;
    for (let i = 0; i <= RATE_LIMITS.authVerification.limit; i++) {
      last = await verifyEmailRoute(post('/api/auth/verify-email', { email: 'ada@example.com', code: '000000' }));
    }
    expect(last?.status).toBe(429);
  });
});
