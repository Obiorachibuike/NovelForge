import { z } from 'zod';
import { apiHandler, readJsonBody, HttpError, MAX_JSON_BYTES } from '@/lib/api/http';
import { clientIp, enforceRateLimit } from '@/lib/security/rate-limit';
import { consumePasswordReset, consumePasswordResetCode, normalizeCode } from '@/services/auth/email-actions';

/**
 * Completes a password reset with either the e-mailed link token or the
 * six-digit passcode that arrives in the same message.
 *
 * `{ token, password }` and `{ email, code, password }` share the same password
 * rules as registration, and both paths consume the action exactly once.
 */
const passwordSchema = z.string().min(8, 'Password must be at least 8 characters.').max(72, 'Password must be at most 72 characters.');
const tokenSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});
const codeSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email address is required.').max(254),
  code: z
    .string()
    .max(16)
    .transform(normalizeCode)
    .refine(code => /^\d{6}$/.test(code), 'Enter the 6-digit code from your email.'),
  password: passwordSchema,
});

export const POST = apiHandler(async (req: Request) => {
  const body = await readJsonBody(req, v => v as Record<string, unknown>, MAX_JSON_BYTES.default);

  if (typeof body?.token === 'string') {
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.errors[0]?.message || 'Invalid request body.', 'validation_failed');
    }
    const ok = await consumePasswordReset(parsed.data.token, parsed.data.password);
    if (!ok) {
      throw new HttpError(
        400,
        'This reset link is invalid, expired, or already used.',
        'invalid_reset_token',
      );
    }
    return Response.json({ ok: true, method: 'link' });
  }

  enforceRateLimit('authVerification', clientIp(req));
  const parsed = codeSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.errors[0]?.message || 'Invalid reset code.', 'validation_failed');
  }
  const ok = await consumePasswordResetCode(parsed.data.email, parsed.data.code, parsed.data.password);
  if (!ok) {
    throw new HttpError(
      400,
      'That code is invalid, expired, or has been used too many times. Request a new reset email.',
      'invalid_reset_code',
    );
  }
  return Response.json({ ok: true, method: 'code' });
});
