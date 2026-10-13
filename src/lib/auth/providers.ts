/**
 * Google sign-in availability.
 *
 * Deliberately dependency-free so server components (login/register pages) can
 * import it without pulling the database or NextAuth into their module graph.
 *
 * Google sign-in is enabled only when **both** credentials are present. A
 * half-configured provider (id without secret, or the reverse) is reported as a
 * problem rather than silently dropped, so a deployment can see it in logs.
 */
export interface GoogleAuthStatus {
  enabled: boolean;
  /** Populated when the provider is half-configured. */
  problem: string | null;
}

export function googleAuthStatus(env: NodeJS.ProcessEnv = process.env): GoogleAuthStatus {
  const id = env.AUTH_GOOGLE_ID?.trim();
  const secret = env.AUTH_GOOGLE_SECRET?.trim();
  if (id && secret) return { enabled: true, problem: null };
  if (id && !secret) return { enabled: false, problem: 'AUTH_GOOGLE_ID is set but AUTH_GOOGLE_SECRET is missing.' };
  if (!id && secret) return { enabled: false, problem: 'AUTH_GOOGLE_SECRET is set but AUTH_GOOGLE_ID is missing.' };
  return { enabled: false, problem: null };
}

export function googleSignInEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return googleAuthStatus(env).enabled;
}

/**
 * The redirect URI to register in the Google Cloud console for this deployment.
 * Google requires an exact match, so surfacing the computed value removes the
 * most common cause of `redirect_uri_mismatch`.
 */
export function googleCallbackUrl(appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL || ''): string {
  const base = appUrl.replace(/\/+$/, '');
  return base ? `${base}/api/auth/callback/google` : '/api/auth/callback/google';
}
