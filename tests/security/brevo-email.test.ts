import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  BREVO_API_URL,
  EmailDeliveryError,
  isEmailDeliveryConfigured,
  parseEmailSender,
  renderPasswordResetEmail,
  renderVerificationEmail,
  resolveEmailConfig,
  sendTransactionalEmail,
} from '@/lib/email';

const env = { ...process.env };

beforeEach(() => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  process.env.MAIL_FROM = 'NovelForge <no-reply@novelforge.example>';
  delete process.env.BREVO_SENDER_EMAIL;
  delete process.env.BREVO_SENDER_NAME;
});

afterEach(() => {
  process.env = { ...env };
  vi.restoreAllMocks();
});

describe('Brevo sender parsing', () => {
  it('accepts Name <email>, bare addresses and drops a missing name', () => {
    expect(parseEmailSender('NovelForge <no-reply@example.com>')).toEqual({
      email: 'no-reply@example.com',
      name: 'NovelForge',
    });
    expect(parseEmailSender('"The Forge" <no-reply@example.com>')).toEqual({
      email: 'no-reply@example.com',
      name: 'The Forge',
    });
    expect(parseEmailSender('  no-reply@example.com  ')).toEqual({ email: 'no-reply@example.com' });
  });

  it('rejects placeholders and malformed values instead of sending from them', () => {
    expect(parseEmailSender('')).toBeNull();
    expect(parseEmailSender('NovelForge <>')).toBeNull();
    expect(parseEmailSender('not-an-address')).toBeNull();
    expect(parseEmailSender('NovelForge <no-reply@localhost>')).toBeNull();
  });
});

describe('Brevo configuration', () => {
  it('is unconfigured without an API key, whatever the sender says', () => {
    delete process.env.BREVO_API_KEY;
    expect(resolveEmailConfig()).toBeNull();
    expect(isEmailDeliveryConfigured()).toBe(false);
  });

  it('is unconfigured when no usable sender exists', () => {
    process.env.MAIL_FROM = 'NovelForge <no-reply@localhost>';
    expect(isEmailDeliveryConfigured()).toBe(false);
  });

  it('reads the sender from MAIL_FROM and defaults the display name', () => {
    process.env.MAIL_FROM = 'no-reply@novelforge.example';
    delete process.env.NEXT_PUBLIC_APP_NAME;
    expect(resolveEmailConfig()).toMatchObject({
      apiKey: 'xkeysib-test-key',
      sender: { email: 'no-reply@novelforge.example', name: 'NovelForge' },
    });
  });

  it('falls back to BREVO_SENDER_EMAIL / BREVO_SENDER_NAME only when MAIL_FROM is absent', () => {
    delete process.env.MAIL_FROM;
    process.env.BREVO_SENDER_EMAIL = 'hello@novelforge.example';
    process.env.BREVO_SENDER_NAME = 'Novel Forge';
    expect(resolveEmailConfig()?.sender).toEqual({ email: 'hello@novelforge.example', name: 'Novel Forge' });
  });
});

describe('Brevo transactional send', () => {
  it('posts the documented body to the transactional endpoint with the api-key header', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ messageId: 'mid-123' }, { status: 201 }));
    const result = await sendTransactionalEmail(
      {
        to: 'writer@example.com',
        toName: 'Ada',
        subject: 'Your NovelForge verification code',
        html: '<p>hello</p>',
        text: 'hello',
        tags: ['auth-verify-email'],
      },
      { fetchImpl: fetchImpl as any },
    );

    expect(result).toEqual({ messageId: 'mid-123' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(BREVO_API_URL);
    expect((init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test-key');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      sender: { email: 'no-reply@novelforge.example', name: 'NovelForge' },
      to: [{ email: 'writer@example.com', name: 'Ada' }],
      subject: 'Your NovelForge verification code',
      htmlContent: '<p>hello</p>',
      textContent: 'hello',
      tags: ['auth-verify-email'],
    });
    // The key travels in a header only, never in the body or URL.
    expect(String(init.body)).not.toContain('xkeysib-test-key');
    expect(url).not.toContain('xkeysib-test-key');
  });

  it('does not retry a 4xx rejection and never leaks the API key in the error', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ code: 'unauthorized', message: 'Key not found' }, { status: 401 }),
    );
    await expect(
      sendTransactionalEmail({ to: 'writer@example.com', subject: 's', html: 'h', text: 't' }, { fetchImpl: fetchImpl as any }),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(
      sendTransactionalEmail({ to: 'writer@example.com', subject: 's', html: 'h', text: 't' }, { fetchImpl: fetchImpl as any }),
    ).rejects.toThrow(/HTTP 401\): Key not found/);
    await expect(
      sendTransactionalEmail({ to: 'writer@example.com', subject: 's', html: 'h', text: 't' }, { fetchImpl: fetchImpl as any }),
    ).rejects.not.toThrow(/xkeysib-test-key/);
  });

  it('retries a 5xx once and succeeds on the second attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ message: 'upstream' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ messageId: 'mid-2' }, { status: 201 }));
    const result = await sendTransactionalEmail(
      { to: 'writer@example.com', subject: 's', html: 'h', text: 't' },
      { fetchImpl: fetchImpl as any, retryDelayMs: 0 },
    );
    expect(result.messageId).toBe('mid-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after the allowed attempts and reports a retryable failure', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ message: 'rate limited' }, { status: 429 }));
    const error = await sendTransactionalEmail(
      { to: 'writer@example.com', subject: 's', html: 'h', text: 't' },
      { fetchImpl: fetchImpl as any, retryDelayMs: 0 },
    ).catch(err => err);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses to send without configuration or a valid recipient', async () => {
    const fetchImpl = vi.fn();
    delete process.env.BREVO_API_KEY;
    await expect(
      sendTransactionalEmail({ to: 'writer@example.com', subject: 's', html: 'h', text: 't' }, { fetchImpl: fetchImpl as any }),
    ).rejects.toThrow(/not configured/);
    process.env.BREVO_API_KEY = 'xkeysib-test-key';
    await expect(
      sendTransactionalEmail({ to: 'not-an-email', subject: 's', html: 'h', text: 't' }, { fetchImpl: fetchImpl as any }),
    ).rejects.toThrow(/valid recipient/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('templates', () => {
  const input = { name: 'Ada', url: 'https://app.example/verify-email?token=abc', code: '042317', linkMinutes: 60, codeMinutes: 10 };

  it('includes both the link and the spaced one-time code in HTML and text', () => {
    const message = renderVerificationEmail(input);
    expect(message.subject).toContain('verification code');
    expect(message.html).toContain('https://app.example/verify-email?token=abc');
    expect(message.html).toContain('042 317');
    expect(message.text).toContain('Or enter this one-time code: 042317');
    expect(message.text).toContain('https://app.example/verify-email?token=abc');
  });

  it('escapes recipient names and the app name in the reset template', () => {
    const message = renderPasswordResetEmail({ ...input, name: '<script>alert(1)</script>' });
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.subject).toContain('password reset code');
  });
});
