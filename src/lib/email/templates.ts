import 'server-only';

/**
 * Transactional email templates.
 *
 * Verification and password-reset messages carry **both** a secure link and a
 * six-digit one-time passcode. The link is the fastest path on the same device;
 * the code is what makes the flow usable when the mail is opened on a phone
 * while sign-up happened on a laptop (mail scanners that pre-open links also
 * cannot burn a code).
 *
 * The markup is a small table-based layout with inline styles because email
 * clients ignore stylesheets. Every message has a plain-text alternative.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface AuthEmailInput {
  /** Recipient display name, if the account has one. */
  name?: string | null;
  /** Absolute, single-use action URL. */
  url: string;
  /** Six-digit one-time passcode. */
  code: string;
  /** How long the link stays valid, in minutes. */
  linkMinutes: number;
  /** How long the passcode stays valid, in minutes. */
  codeMinutes: number;
  appName?: string;
}

const BRAND = {
  ink: '#0b1020',
  body: '#334155',
  muted: '#64748b',
  accent: '#4f46e5',
  border: '#e2e8f0',
  surface: '#f8fafc',
};

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `123456` → `123 456`, easier to read and transcribe. */
export function formatCode(code: string): string {
  const digits = String(code).replace(/\s+/g, '');
  return digits.length === 6 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
}

interface LayoutInput {
  appName: string;
  preheader: string;
  heading: string;
  intro: string;
  url: string;
  ctaLabel: string;
  code: string;
  linkMinutes: number;
  codeMinutes: number;
  footer: string;
}

function layout(input: LayoutInput): string {
  const app = escapeHtml(input.appName);
  const safeUrl = escapeHtml(input.url);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.surface};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.surface};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BRAND.border};border-radius:16px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
          <tr>
            <td style="padding-bottom:8px;font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:${BRAND.accent};font-weight:700;">${app}</td>
          </tr>
          <tr>
            <td style="padding-bottom:12px;font-size:24px;line-height:1.25;color:${BRAND.ink};font-weight:700;">${escapeHtml(input.heading)}</td>
          </tr>
          <tr>
            <td style="padding-bottom:24px;font-size:15px;line-height:1.6;color:${BRAND.body};">${input.intro}</td>
          </tr>
          <tr>
            <td style="padding-bottom:28px;">
              <a href="${safeUrl}" style="display:inline-block;background:${BRAND.accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:10px;">${escapeHtml(input.ctaLabel)}</a>
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${BRAND.muted};font-weight:700;">Or enter this one-time code</td>
          </tr>
          <tr>
            <td style="padding-bottom:6px;">
              <span style="display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:30px;letter-spacing:.28em;font-weight:700;color:${BRAND.ink};background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:12px;padding:14px 18px;">${escapeHtml(formatCode(input.code))}</span>
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:24px;font-size:13px;line-height:1.6;color:${BRAND.muted};">
              The code expires in ${input.codeMinutes} minutes. The button above works for ${input.linkMinutes} hour${input.linkMinutes === 1 ? '' : 's'}.
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:24px;border-top:1px solid ${BRAND.border};padding-top:20px;font-size:12px;line-height:1.6;color:${BRAND.muted};word-break:break-all;">
              Button not working? Paste this link into your browser:<br />
              <a href="${safeUrl}" style="color:${BRAND.accent};">${safeUrl}</a>
            </td>
          </tr>
          <tr>
            <td style="border-top:1px solid ${BRAND.border};padding-top:20px;font-size:12px;line-height:1.6;color:${BRAND.muted};">
              ${escapeHtml(input.footer)}<br /><br />
              ${app} never asks for your password by email. If you were not expecting this message, no action is needed.
            </td>
          </tr>
        </table>
        <div style="max-width:560px;padding:18px 8px 0;font-size:11px;line-height:1.6;color:${BRAND.muted};text-align:center;">
          Sent by ${app}. Replies to this address are not monitored.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function textBody(input: {
  appName: string;
  heading: string;
  intro: string;
  url: string;
  code: string;
  linkMinutes: number;
  codeMinutes: number;
  footer: string;
}): string {
  return [
    `${input.heading} — ${input.appName}`,
    '',
    input.intro.replace(/<[^>]+>/g, ''),
    '',
    `Open this link: ${input.url}`,
    '',
    `Or enter this one-time code: ${input.code}`,
    `The code expires in ${input.codeMinutes} minutes. The link works for ${input.linkMinutes} hour${input.linkMinutes === 1 ? '' : 's'}.`,
    '',
    input.footer,
    `${input.appName} never asks for your password by email. If you were not expecting this message, no action is needed.`,
  ].join('\n');
}

/** "Confirm your email address" — sent on registration and on resend. */
export function renderVerificationEmail(input: AuthEmailInput): RenderedEmail {
  const appName = input.appName || 'NovelForge';
  const greeting = input.name ? `Hi ${escapeHtml(input.name)},` : 'Hi,';
  const heading = 'Confirm your email address';
  const intro = `${greeting} welcome to ${escapeHtml(appName)}. Confirm this address to activate your account and start writing — you only need to do this once.`;
  return {
    subject: `Your ${appName} verification code`,
    html: layout({
      appName,
      preheader: `Confirm your ${appName} account with the button or the code inside.`,
      heading,
      intro,
      url: input.url,
      ctaLabel: 'Confirm email address',
      code: input.code,
      linkMinutes: Math.max(1, Math.round(input.linkMinutes)),
      codeMinutes: Math.round(input.codeMinutes),
      footer: 'If you did not create an account, you can safely ignore this email.',
    }),
    text: textBody({
      appName,
      heading,
      intro,
      url: input.url,
      code: input.code,
      linkMinutes: Math.max(1, Math.round(input.linkMinutes)),
      codeMinutes: Math.round(input.codeMinutes),
      footer: 'If you did not create an account, you can safely ignore this email.',
    }),
  };
}

/** "Reset your password" — sent by the forgot-password flow. */
export function renderPasswordResetEmail(input: AuthEmailInput): RenderedEmail {
  const appName = input.appName || 'NovelForge';
  const greeting = input.name ? `Hi ${escapeHtml(input.name)},` : 'Hi,';
  const heading = 'Reset your password';
  const intro = `${greeting} we received a request to reset the password for your ${escapeHtml(appName)} account. Choose a new password with the button below, or enter the code on the reset page.`;
  return {
    subject: `Your ${appName} password reset code`,
    html: layout({
      appName,
      preheader: `Reset your ${appName} password with the button or the code inside.`,
      heading,
      intro,
      url: input.url,
      ctaLabel: 'Choose a new password',
      code: input.code,
      linkMinutes: Math.max(1, Math.round(input.linkMinutes)),
      codeMinutes: Math.round(input.codeMinutes),
      footer: 'If you did not request a password reset, ignore this email — your password stays unchanged.',
    }),
    text: textBody({
      appName,
      heading,
      intro,
      url: input.url,
      code: input.code,
      linkMinutes: Math.max(1, Math.round(input.linkMinutes)),
      codeMinutes: Math.round(input.codeMinutes),
      footer: 'If you did not request a password reset, ignore this email — your password stays unchanged.',
    }),
  };
}
