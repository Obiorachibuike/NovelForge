import type { NextAuthConfig } from 'next-auth';

/**
 * Session-verification-only config (no database or other Node-only imports) so
 * middleware can run on the Edge runtime.
 */
function resolveTrustHost(): boolean {
  // Explicit opt-in/out wins; otherwise trust the host on Vercel and in local
  // development, but not in a self-hosted production deployment where a
  // mis-configured proxy could be used to forge callback URLs.
  const explicit = process.env.AUTH_TRUST_HOST;
  if (explicit) return explicit !== 'false';
  return process.env.VERCEL === '1' || process.env.NODE_ENV !== 'production';
}

export const edgeAuthConfig: NextAuthConfig = {
  trustHost: resolveTrustHost(),
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [],
  callbacks: {
    async session({ session, token }) {
      if (session.user) {
        const id = token.id as string | undefined;
        if (!id) {
          // No database id in the token: fail closed by clearing the user so
          // requireUser() rejects the session instead of authorising it.
          (session as any).user = null;
          return session;
        }
        (session.user as any).id = id;
      }
      return session;
    },
  },
};
