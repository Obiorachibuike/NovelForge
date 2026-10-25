import { z } from 'zod';
import { apiHandler, readJsonBody, HttpError, MAX_JSON_BYTES } from '@/lib/api/http';
import { clientIp, enforceRateLimit } from '@/lib/security/rate-limit';
import {
  consumeEmailVerification,
  consumeEmailVerificationCode,
  normalizeCode,
} from '@/services/auth/email-actions';

/**
 * Redeems either half of the verification e-mail.
 *
 * - `{ token }` — the one-time link (one hour, single use).
 * - `{ email, code }` — the six-digit passcode (ten minutes, five attempts).
 *
 * Code submissions are rate limited per client IP in addition to the per-row
 * attempt counter, because the attempt counter alone would let a caller rotate
 * addresses to keep guessing.
 */
const tokenSchema = z.object({ token: z.string().min(20).max(200) });
const codeSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email address is required.').max(254),
  code: z
    .string()
    .max(16)
    .transform(normalizeCode)
    .refine(code => /^\d{6}$/.test(code), 'Enter the 6-digit code from your email.'),
});

export const POST = apiHandler(async (req: Request) => {
  const body = await readJsonBody(req, v => v as Record<string, unknown>, MAX_JSON_BYTES.default);

  if (typeof body?.token === 'string') {
    const { token } = tokenSchema.parse(body);
    const ok = await consumeEmailVerification(token);
    if (!ok) {
      throw new HttpError(
        400,
        'This verification link is invalid, expired, or already used.',
        'invalid_verification_token',
      );
    }
    return Response.json({ ok: true, method: 'link' });
  }

  enforceRateLimit('authVerification', clientIp(req));
  const parsed = codeSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.errors[0]?.message || 'Invalid verification code.', 'validation_failed');
  }
  const ok = await consumeEmailVerificationCode(parsed.data.email, parsed.data.code);
  if (!ok) {
    throw new HttpError(
      400,
      'That code is invalid, expired, or has been used too many times. Request a new verification email.',
      'invalid_verification_code',
    );
  }
  return Response.json({ ok: true, method: 'code' });
});
