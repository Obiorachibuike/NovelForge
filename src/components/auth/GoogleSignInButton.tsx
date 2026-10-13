'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { Loader2 } from 'lucide-react';

/**
 * "Continue with Google".
 *
 * Only rendered when the server confirmed the provider is configured (see
 * src/lib/auth/providers.ts), so the button is never a dead end. Sign-in goes
 * through NextAuth's own redirect flow; the account-linking policy lives on the
 * server in `resolveGoogleSignIn`.
 */
export default function GoogleSignInButton({
  callbackUrl = '/dashboard',
  label = 'Continue with Google',
  disabled = false,
}: {
  callbackUrl?: string;
  label?: string;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      className="btn-outline w-full"
      disabled={disabled || pending}
      onClick={() => {
        setPending(true);
        // Redirects away on success; on failure NextAuth returns to /login.
        void signIn('google', { callbackUrl });
      }}
      aria-label={label}
    >
      {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <GoogleMark />}
      {pending ? 'Redirecting to Google…' : label}
    </button>
  );
}

function GoogleMark() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.44a5.5 5.5 0 0 1-2.39 3.61v3h3.86c2.26-2.08 3.61-5.15 3.61-8.8Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.95-2.93l-3.87-3a7.2 7.2 0 0 1-4.08 1.15c-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.26a7.2 7.2 0 0 1 0-4.51V6.66H1.29a12 12 0 0 0 0 10.68l3.98-3.08Z" />
      <path fill="#EA4335" d="M12 4.77c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.66l3.98 3.09C6.22 6.88 8.87 4.77 12 4.77Z" />
    </svg>
  );
}
