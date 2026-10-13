/**
 * Bootstrap an administrator.
 *
 *   npm run admin:grant -- you@example.com      # promote
 *   npm run admin:grant -- you@example.com --revoke
 *
 * Needed because the admin API requires an existing admin: the first one is
 * created here, or by listing the address in ADMIN_EMAILS (which the app
 * honours automatically). Every change is written to the audit log.
 */
import { getDb, closeDb } from '../src/lib/db';
import { nanoid } from 'nanoid';

const [, , emailRaw, ...flags] = process.argv;
const email = (emailRaw || '').trim().toLowerCase();
const revoke = flags.includes('--revoke');

if (!email || !email.includes('@')) {
  console.error('usage: npm run admin:grant -- <email> [--revoke]');
  process.exit(1);
}

const db = getDb();
const user = db.prepare('SELECT id, name, email, role FROM users WHERE lower(email)=?').get(email) as any;
if (!user) {
  console.error(`error: no account for ${email}. The user must register (or sign in with Google) first.`);
  process.exitCode = 1;
} else {
  const role = revoke ? 'user' : 'admin';
  const now = new Date().toISOString();

  if (!revoke) {
    const admins = (db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role='admin' AND id != ?`).get(user.id) as any).c;
    if (admins === 0) console.log('[admin:grant] this will be the only administrator account');
  }

  db.prepare('UPDATE users SET role=?, updatedAt=? WHERE id=?').run(role, now, user.id);
  db.prepare('INSERT INTO admin_audit_log (id,actorId,targetUserId,action,details,createdAt) VALUES (?,?,?,?,?,?)')
    .run(nanoid(), 'cli', user.id, revoke ? 'role_revoked_cli' : 'role_granted_cli', JSON.stringify({ email }), now);

  console.log(`${revoke ? 'revoked admin from' : 'granted admin to'} ${user.email} (${user.name || 'no name'})`);
  console.log('Free novel creation is included with the admin role. To give a normal account free access, use the admin console at /admin.');
}

closeDb();
