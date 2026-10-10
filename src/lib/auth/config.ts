import NextAuth, { type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import bcrypt from 'bcryptjs';
import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import { edgeAuthConfig } from './edge-config';

export const authConfig: NextAuthConfig = {
  ...edgeAuthConfig,
  providers: [
    ...(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
      ? [Google({ clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET })]
      : []),
    Credentials({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        name: { label: 'Name', type: 'text' },
      },
      async authorize(creds) {
        const rawEmail = creds?.email as string|undefined;
        const rawPassword = creds?.password as string|undefined;
        const rawName = (creds?.name as string|undefined) || '';
        const email = String(rawEmail || '').trim().toLowerCase();
        const password = String(rawPassword || '');
        if (!email || !password) throw new Error('Email and password are required.');

        const db = getDb();
        const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;

        if (!existing) {
          // Attempt registration when email doesn't exist
          if (password.length < 8) throw new Error('Password must be at least 8 characters.');
          const id = nanoid();
          const hash = await bcrypt.hash(password, 10);
          const now = new Date().toISOString();
          const name = rawName.trim() || email.split('@')[0];
          db.prepare(
            'INSERT INTO users (id,name,email,passwordHash,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)'
          ).run(id, name, email, hash, null, now, now);
          return { id, email, name } as any;
        }

        if (!existing.passwordHash) throw new Error('Account exists but uses a different sign-in method.');
        const ok = await bcrypt.compare(password, existing.passwordHash);
        if (!ok) throw new Error('Invalid email or password.');
        return { id: existing.id, email: existing.email, name: existing.name, image: existing.image } as any;
      },
    }),
  ],
  callbacks: {
    ...edgeAuthConfig.callbacks,
    async jwt({ token, user, account }) {
      if (user) { token.id = (user as any).id; token.name = user.name; token.email = user.email; token.image = (user as any).image; }
      if (account?.provider === 'google' && token.email) {
        const db = getDb();
        const u = db.prepare('SELECT id FROM users WHERE email = ?').get(token.email) as any;
        if (u) token.id = u.id;
      }
      return token;
    },
    async signIn({ user, account, profile }) {
      if (account?.provider === 'google' && user.email) {
        const db = getDb();
        const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(user.email) as any;
        if (!existing) {
          const id = nanoid();
          const now = new Date().toISOString();
          db.prepare(
            'INSERT INTO users (id,name,email,image,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)'
          ).run(id, user.name || user.email.split('@')[0], user.email, user.image || null, now, now, now);
          // ensure account row is tracked via adapter (we don't use adapter for simplicity here)
        }
      }
      return true;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
