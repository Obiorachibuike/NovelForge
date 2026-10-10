import 'server-only';
import { getDb } from '@/lib/db';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) throw new HttpError(401, 'Not authenticated');
  return session.user as { id: string; email?: string|null; name?: string|null; image?: string|null };
}

/** Throws 404 if the novel doesn't exist or belongs to someone else. */
export async function requireNovel(novelId: string, userId?: string) {
  const uid = userId || (await requireUser()).id;
  const db = getDb();
  const novel = db.prepare('SELECT * FROM novels WHERE id = ? AND userId = ?').get(novelId, uid) as any;
  if (!novel) throw new HttpError(404, 'Novel not found');
  return novel;
}

export function jsonError(res: any, err: unknown) {
  const e = err as HttpError;
  return Response.json({ error: e?.message || 'Internal error' }, { status: e?.status || 500 });
}
