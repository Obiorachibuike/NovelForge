import 'server-only';
import { getDb } from '@/lib/db';
import { auth } from '@/lib/auth/config';
import { HttpError } from '@/lib/api/http';

export { HttpError } from '@/lib/api/http';
export { errorResponse as jsonError } from '@/lib/api/http';

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) throw new HttpError(401, 'Not authenticated', 'unauthenticated');
  const db = getDb();
  const row = db.prepare('SELECT status FROM users WHERE id = ?').get(session.user.id) as { status?: string } | undefined;
  if (row?.status === 'suspended') {
    throw new HttpError(403, 'This account has been suspended.', 'account_suspended');
  }
  return session.user as { id: string; email?: string | null; name?: string | null; image?: string | null };
}

/** Throws 404 if the novel doesn't exist or belongs to someone else. */
export async function requireNovel(novelId: string, userId?: string) {
  const uid = userId || (await requireUser()).id;
  const db = getDb();
  const novel = db.prepare('SELECT * FROM novels WHERE id = ? AND userId = ?').get(novelId, uid) as any;
  if (!novel) throw new HttpError(404, 'Novel not found', 'novel_not_found');
  return novel;
}

/**
 * Loads a chapter only when it belongs to a novel owned by `userId`.
 *
 * This is the single, structural ownership check used by every chapter-scoped
 * endpoint (including the AI editor). It joins on `novels.userId` so a chapter
 * id belonging to another account can never be returned.
 */
export async function requireChapter(chapterId: string, userId?: string) {
  const uid = userId || (await requireUser()).id;
  const db = getDb();
  const chapter = db.prepare(
    `SELECT c.*, n.userId AS ownerId, n.title AS novelTitle, n.tone, n.pov, n.genre
       FROM chapters c JOIN novels n ON n.id = c.novelId
      WHERE c.id = ? AND n.userId = ?`,
  ).get(chapterId, uid) as any;
  if (!chapter) throw new HttpError(404, 'Chapter not found', 'chapter_not_found');
  return chapter;
}

/** Loads a generation job only when it belongs to the authenticated user. */
export async function requireJob(jobId: string, userId?: string) {
  const uid = userId || (await requireUser()).id;
  const db = getDb();
  const job = db.prepare('SELECT * FROM generation_jobs WHERE id = ? AND userId = ?').get(jobId, uid) as any;
  if (!job) throw new HttpError(404, 'Job not found', 'job_not_found');
  return job;
}

/** Loads an export row only when it belongs to the authenticated user. */
export async function requireExportRecord(exportId: string, userId?: string) {
  const uid = userId || (await requireUser()).id;
  const db = getDb();
  const row = db.prepare('SELECT * FROM exports WHERE id = ? AND userId = ?').get(exportId, uid) as any;
  if (!row) throw new HttpError(404, 'Export not found', 'export_not_found');
  return row;
}
