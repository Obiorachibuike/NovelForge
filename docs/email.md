# Transactional email (Brevo)

NovelForge sends **all** product email through [Brevo](https://developers.brevo.com/docs/getting-started):
account verification, one-time passcodes and password resets. There is no second
provider and no SMTP transport — a single HTTP client keeps credentials, retries
and error handling in one place.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `BREVO_API_KEY` | yes (production) | Brevo API key, sent in the `api-key` request header |
| `MAIL_FROM` | yes (production) | Verified Brevo sender, `Name <email@domain>` or a bare address |
| `BREVO_SENDER_EMAIL` | no | Sender fallback used only when `MAIL_FROM` is unset |
| `BREVO_SENDER_NAME` | no | Display name used when the sender has none |
| `NEXT_PUBLIC_APP_URL` | yes | Absolute origin for the links inside the messages |

Where to get them: Brevo → **SMTP & API → API Keys** for the key, and
**Senders, Domains & Dedicated IPs** to verify the sending domain. The address in
`MAIL_FROM` must be a verified sender, otherwise Brevo answers `400` and the
send fails loudly (the failure is logged, never the key).

Validation (`src/lib/config/env.ts`):

- `BREVO_API_KEY` set but the sender unusable → **startup error** (fail fast,
  not mid-registration).
- Nothing configured → warning in production; in development the message
  material is written to the server console instead of being sent, so a local
  instance still works without an account at Brevo.
- `GET /api/health` returns `email: { provider: 'brevo', configured: true|false }`.

## Request shape

`src/lib/email/brevo.ts` posts to `https://api.brevo.com/v3/smtp/email`:

```json
{
  "sender": { "email": "no-reply@your-domain.example", "name": "NovelForge" },
  "to": [{ "email": "writer@example.com" }],
  "subject": "Your NovelForge verification code",
  "htmlContent": "…",
  "textContent": "…",
  "tags": ["auth-verify-email"]
}
```

Behaviour:

- 10 s timeout per attempt (`AbortSignal.timeout`).
- One retry for retryable answers only: `408`, `429`, `5xx`, network errors and
  timeouts. `4xx` validation/auth failures are never retried, so a bad key or
  unverified sender does not multiply requests.
- Errors are `EmailDeliveryError` with the HTTP status, a redacted provider
  message and a `retryable` flag. The API key is never included.
- The HTML is a table layout with inline styles; every message also has a plain
  text alternative for clients that refuse HTML.

## Messages

Every verification and reset message carries **two independent secrets**:

| Secret | Form | Lifetime | Storage | Attempts |
| --- | --- | --- | --- | --- |
| Link token | 32 random bytes, base64url, in `?token=` | 1 hour | SHA-256 in `auth_action_tokens.tokenHash` | single use |
| One-time code | 6 digits from the CSPRNG | 10 minutes | bcrypt in `auth_action_tokens.codeHash` | 5 wrong tries |

Using either one consumes the row, which invalidates the other. Issuing a new
message deletes any previous row for the same address and purpose, so only the
newest email works.

Codes are generated with `crypto.randomInt` (uniform, no `Math.random`), keep
leading zeros, and are accepted as `123456`, `123 456` or `123-456`.

Attempt accounting increments **before** the bcrypt comparison, so parallel
guessing cannot exceed five tries; the row is destroyed at the limit or on
expiry. Code submissions are additionally rate limited per IP
(`RATE_LIMIT_AUTH_VERIFICATION_PER_HOUR`, default 20/hour).

## Flows

| Flow | Entry point | Completed by |
| --- | --- | --- |
| Registration | `POST /api/auth/register` (sends the message) | link `/verify-email?token=…` or `POST /api/auth/verify-email { email, code }` |
| Resend verification | `POST /api/auth/resend-verification` | as above |
| Forgot password | `POST /api/auth/forgot-password` | link `/reset-password?token=…` or `POST /api/auth/reset-password { email, code, password }` |

Pages: `/verify-email` (auto-verifies a link token, or accepts email + code) and
`/reset-password` (token form, with a "use the code instead" switch).
`/forgot-password` links straight to the code form after the request.

Responses never reveal whether an address exists: unknown addresses get the same
generic success body as known ones, and only the account owner receives mail.

## Database

Migration `0011_auth_otp_codes` adds `codeHash`, `codeExpiresAt` and
`failedAttempts` to `auth_action_tokens` (created by `0010_auth_recovery_tokens`).
Run `npm run db:migrate` before deploying this build.

## Tests

`tests/security/auth-email-actions.test.ts` (flows, codes, rate/quota
behaviour) and `tests/security/brevo-email.test.ts` (request shape, sender
parsing, retry/error handling) stub `fetch`; no test contacts Brevo.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Brevo rejected the message (HTTP 401)` | Wrong or revoked `BREVO_API_KEY` |
| `Brevo rejected the message (HTTP 400)… sender` | `MAIL_FROM` is not a verified Brevo sender |
| Links point at `localhost` | `NEXT_PUBLIC_APP_URL` / `NEXTAUTH_URL` unset in production |
| Message arrives without the code block | HTML is rendered by a client that strips it — use the text part |
| `[auth] Email delivery is not configured` in the console | Development fallback: set `BREVO_API_KEY` and `MAIL_FROM` to send for real |
