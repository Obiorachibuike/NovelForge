import 'server-only';

/**
 * Brevo transactional email client.
 *
 * NovelForge sends every transactional message (email verification links,
 * one-time passcodes, password resets) through Brevo's transactional email API:
 * `POST https://api.brevo.com/v3/smtp/email` with the API key in the `api-key`
 * header. See https://developers.brevo.com/reference/send-transac-email.
 *
 * The client is deliberately tiny and dependency-free: the app already fetches
 * every other provider over HTTP, and a plain `fetch` keeps the request shape
 * (and the failure modes) visible in the code review.
 */

export const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
export const DEFAULT_EMAIL_TIMEOUT_MS = 10_000;

export interface EmailSender {
  email: string;
  name?: string;
}

export interface EmailConfig {
  apiKey: string;
  sender: EmailSender;
}

export interface OutgoingEmail {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text: string;
  /** Brevo tags, useful for filtering delivery stats per message type. */
  tags?: string[];
  replyTo?: EmailSender;
}

const EMAIL_PATTERN = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;

/** Parses `Name <email@example.com>`, `"Name" <email>` or a bare address. */
export function parseEmailSender(raw: string | undefined | null): EmailSender | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const angled = value.match(/^(.*?)<([^<>]+)>$/);
  const email = (angled ? angled[2] : value).trim();
  if (!EMAIL_PATTERN.test(email)) return null;
  if (!angled) return { email };
  const name = angled[1].trim().replace(/^"(.*)"$/, '$1').trim();
  return name ? { email, name } : { email };
}

/**
 * Reads the provider configuration from the environment.
 *
 * `MAIL_FROM` is the single, shared sender identity for every message so the
 * verified Brevo sender domain is configured in exactly one place.
 * `BREVO_SENDER_EMAIL` / `BREVO_SENDER_NAME` are accepted as a fallback for
 * deployments that prefer provider-specific names.
 */
export function resolveEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig | null {
  const apiKey = String(env.BREVO_API_KEY ?? '').trim();
  if (!apiKey) return null;

  const sender =
    parseEmailSender(env.MAIL_FROM) ??
    parseEmailSender(env.BREVO_SENDER_EMAIL) ??
    null;
  if (!sender) return null;

  const explicitName = String(env.BREVO_SENDER_NAME ?? '').trim();
  if (explicitName && !sender.name) sender.name = explicitName;
  if (!sender.name) sender.name = String(env.NEXT_PUBLIC_APP_NAME ?? '').trim() || 'NovelForge';
  return { apiKey, sender };
}

/**
 * True when a message can actually be sent. Callers use this to choose between
 * real delivery and the development console fallback, and to report a precise
 * configuration error instead of a generic failure.
 */
export function isEmailDeliveryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEmailConfig(env) !== null;
}

export class EmailDeliveryError extends Error {
  /** HTTP status returned by Brevo, when the failure came from the API. */
  status?: number;
  /** Whether a later attempt could plausibly succeed (rate limit, 5xx, network). */
  retryable: boolean;
  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'EmailDeliveryError';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

interface SendOptions {
  /** Overrides the timeout of a single attempt. */
  timeoutMs?: number;
  /** Total attempts (1 = no retry). Retries only happen on retryable failures. */
  attempts?: number;
  /** Delay between retryable attempts. */
  retryDelayMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Never echo the API key or an unbounded upstream body back to the caller. */
function describeBrevoFailure(status: number, body: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = String(parsed?.message ?? parsed?.error ?? '').trim();
  } catch {
    detail = body.trim();
  }
  detail = detail.replace(/\s+/g, ' ').slice(0, 200);
  return `Brevo rejected the message (HTTP ${status})${detail ? `: ${detail}` : '.'}`;
}

/**
 * Sends one transactional email and resolves with Brevo's message id.
 *
 * Throws `EmailDeliveryError` for provider/network failures. Callers decide
 * whether a failed send blocks the user action (it must not for registration:
 * the account is created and the user can request another link).
 */
export async function sendTransactionalEmail(
  message: OutgoingEmail,
  options: SendOptions = {},
): Promise<{ messageId?: string }> {
  const config = resolveEmailConfig(options.env ?? process.env);
  if (!config) {
    throw new EmailDeliveryError(
      'Email delivery is not configured. Set BREVO_API_KEY and MAIL_FROM.',
    );
  }
  const to = String(message.to ?? '').trim();
  if (!EMAIL_PATTERN.test(to)) {
    throw new EmailDeliveryError('A valid recipient email address is required.');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = Math.max(1, Math.floor(options.attempts ?? 2));
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMAIL_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? 400;

  const body = JSON.stringify({
    sender: config.sender,
    to: [message.toName ? { email: to, name: message.toName } : { email: to }],
    subject: message.subject,
    htmlContent: message.html,
    textContent: message.text,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(message.tags?.length ? { tags: message.tags } : {}),
  });

  let lastError: EmailDeliveryError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(BREVO_API_URL, {
        method: 'POST',
        headers: {
          'api-key': config.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const raw = await response.text().catch(() => '');
      if (!response.ok) {
        const retryable =
          response.status === 429 || response.status === 408 || response.status >= 500;
        lastError = new EmailDeliveryError(describeBrevoFailure(response.status, raw), {
          status: response.status,
          retryable,
        });
        if (!retryable) throw lastError;
      } else {
        let messageId: string | undefined;
        try {
          messageId = JSON.parse(raw)?.messageId;
        } catch {
          messageId = undefined;
        }
        return { messageId };
      }
    } catch (err) {
      if (err instanceof EmailDeliveryError) {
        if (!err.retryable) throw err;
        lastError = err;
      } else {
        // Network failure, DNS problem or the timeout abort.
        lastError = new EmailDeliveryError(
          `Could not reach Brevo: ${(err as Error)?.name === 'TimeoutError' ? 'request timed out' : 'network error'}.`,
          { retryable: true },
        );
      }
    }

    if (attempt < attempts) await sleep(retryDelayMs);
  }

  throw lastError ?? new EmailDeliveryError('Email delivery failed.');
}
