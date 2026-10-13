import NextAuth, { type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import { edgeAuthConfig } from './edge-config';
import { googleAuthStatus } from './providers';
import {
  verifyCredentials, resolveGoogleSignIn, recordOAuthAccount, assertAuthConfiguration,
} from '@/services/auth/service';

const google = googleAuthStatus();
const googleEnabled = google.enabled;
if (google.problem) {
  // Half-configured OAuth is a deployment mistake, not a silent downgrade.
  console.warn(`[auth] Google sign-in disabled: ${google.problem}`);
}

export const authConfig: NextAuthConfig = {
  ...edgeAuthConfig,
  providers: [
    ...(googleEnabled
      ? [Google({
          clientId: process.env.AUTH_GOOGLE_ID!,
          clientSecret: process.env.AUTH_GOOGLE_SECRET!,
          // Let the user pick which Google account to use, and never trust a
          // stale consent screen for account linking.
          authorization: {
            params: { prompt: 'select_account', access_type: 'online' },
          },
          // A Google identity is linked only through resolveGoogleSignIn, never
          // automatically by an adapter's own account matching.
          allowDangerousEmailAccountLinking: false,
        })]
      : []),
    Credentials({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      /**
       * Login only. Account creation lives in POST /api/auth/register so that
       * an unknown e-mail can never create an account (or reveal that it does
       * not exist) from the sign-in form.
       */
      async authorize(creds) {
        assertAuthConfiguration();
        const user = await verifyCredentials(
          String(creds?.email || ''),
          String(creds?.password || ''),
        );
        return user ? ({ ...user } as any) : null;
      },
    }),
  ],
  callbacks: {
    ...edgeAuthConfig.callbacks,
    async jwt({ token, user, account, profile }) {
      if (user && (user as any).id) {
        token.id = (user as any).id;
        token.name = user.name;
        token.email = user.email;
        token.picture = (user as any).image ?? token.picture;
      }
      // OAuth sign-ins have no database id yet: resolve it (creating the row if
      // necessary) through the safe-linking policy, then persist the link.
      if (account?.provider === 'google' && (profile as any)?.email) {
        const decision = await resolveGoogleSignIn({
          email: (profile as any).email,
          name: user?.name ?? null,
          image: user?.image ?? null,
          providerAccountId: account.providerAccountId,
        });
        if (!decision.allow) {
          console.warn(`[auth] refused Google sign-in in the jwt callback: ${decision.reason}`);
          delete (token as any).id;
          return token;
        }

        const link = recordOAuthAccount({
          userId: decision.userId,
          provider: 'google',
          providerAccountId: account.providerAccountId,
        });
        if (link.conflict) {
          // The Google account is bound to another user: never issue a session
          // for it. The session callback clears the user when the token has no
          // id, so this fails closed.
          console.warn('[auth] refused Google sign-in: provider account already linked to another user.');
          delete (token as any).id;
          return token;
        }

        token.id = decision.userId;
      }
      return token;
    },

    /**
     * Deny OAuth sign-in when linking would be unsafe (see resolveGoogleSignIn)
     * and record the verification state for accepted sign-ins.
     */
    async signIn({ user, account, profile }) {
      assertAuthConfiguration();
      if (account?.provider !== 'google') return true;

      const googleProfile = (profile ?? {}) as any;
      const email = googleProfile.email || user.email;
      if (!email) {
        console.warn('[auth] refused Google sign-in: no email address on the profile.');
        return false;
      }
      // Google only issues this claim for addresses it has verified. Treat an
      // explicit `false` as untrusted rather than linking on it.
      if (googleProfile.email_verified === false || googleProfile.verified_email === false) {
        console.warn(`[auth] refused Google sign-in for ${email}: Google reports the address as unverified.`);
        return false;
      }

      const decision = await resolveGoogleSignIn({
        email,
        name: user?.name ?? googleProfile.name ?? null,
        image: user?.image ?? googleProfile.picture ?? null,
        providerAccountId: account.providerAccountId,
      });
      if (!decision.allow) {
        console.warn(`[auth] refused Google sign-in for ${email}: ${decision.reason}`);
        return false;
      }
      return true;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
