import 'server-only';
import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import {
  GenerationEventType,
  NotificationKind,
  stageLabel,
  type GenerationJobRow,
} from './job-types';

/**
 * Persistent notifications.
 *
 * Notifications are rows (not floating toasts) so the notification centre can
 * restore them after a refresh or a full application restart. `dedupeKey`
 * carries the job id *and* attempt number: a retry has its own legitimate
 * outcome notification, while a pg-boss redelivery or worker restart of the
 * same attempt cannot create a duplicate.
 */

export interface NotificationRow {
  id: string;
  userId: string;
  kind: string;
  title: string;
  message: string;
  novelId?: string | null;
  chapterId?: string | null;
  generationJobId?: string | null;
  isRead: number | boolean;
  dedupeKey?: string | null;
  createdAt: string;
}

export function createNotification(input: {
  userId: string;
  kind: NotificationKind | string;
  title: string;
  message: string;
  novelId?: string | null;
  chapterId?: string | null;
  generationJobId?: string | null;
  dedupeKey?: string | null;
  createdAt?: string;
}): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO notifications
        (id,userId,kind,title,message,novelId,chapterId,generationJobId,isRead,dedupeKey,createdAt)
       VALUES (?,?,?,?,?,?,?,?,0,?,?)`,
    )
    .run(
      nanoid(),
      input.userId,
      input.kind,
      input.title,
      input.message,
      input.novelId ?? null,
      input.chapterId ?? null,
      input.generationJobId ?? null,
      input.dedupeKey ?? null,
      input.createdAt ?? new Date().toISOString(),
    );
  return result.changes > 0;
}

export function listNotifications(
  userId: string,
  options: { limit?: number; unreadOnly?: boolean } = {},
): NotificationRow[] {
  const db = getDb();
  const limit = Math.min(100, Math.max(1, options.limit ?? 30));
  if (options.unreadOnly) {
    return db
      .prepare(
        'SELECT * FROM notifications WHERE userId=? AND isRead=0 ORDER BY createdAt DESC LIMIT ?',
      )
      .all(userId, limit) as NotificationRow[];
  }
  return db
    .prepare('SELECT * FROM notifications WHERE userId=? ORDER BY createdAt DESC LIMIT ?')
    .all(userId, limit) as NotificationRow[];
}

export function unreadNotificationCount(userId: string): number {
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) AS total FROM notifications WHERE userId=? AND isRead=0')
    .get(userId) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

export function markNotificationRead(userId: string, id: string): boolean {
  const db = getDb();
  const res = db
    .prepare('UPDATE notifications SET isRead=1 WHERE id=? AND userId=?')
    .run(id, userId);
  return res.changes > 0;
}

export function markAllNotificationsRead(userId: string): number {
  const db = getDb();
  const res = db.prepare('UPDATE notifications SET isRead=1 WHERE userId=? AND isRead=0').run(userId);
  return res.changes;
}

export function serializeNotification(row: NotificationRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    message: row.message,
    novelId: row.novelId ?? null,
    chapterId: row.chapterId ?? null,
    generationJobId: row.generationJobId ?? null,
    isRead: Boolean(row.isRead),
    createdAt: row.createdAt,
    href:
      row.novelId && row.chapterId
        ? `/novels/${row.novelId}/write/${row.chapterId}`
        : row.novelId
          ? `/novels/${row.novelId}`
          : null,
  };
}

interface NotificationContext {
  novelTitle?: string | null;
  chapterTitle?: string | null;
  chapterId?: string | null;
}

function loadNotificationContext(job: GenerationJobRow): NotificationContext {
  const db = getDb();
  const novel = db.prepare('SELECT title FROM novels WHERE id=?').get(job.novelId) as
    | { title: string }
    | undefined;
  const chapter = job.chapterId
    ? (db
        .prepare('SELECT id,title,chapterNumber FROM chapters WHERE id=?')
        .get(job.chapterId) as { id: string; title: string; chapterNumber: number } | undefined)
    : undefined;
  return {
    novelTitle: novel?.title ?? null,
    chapterTitle: chapter?.title ?? null,
    chapterId: chapter?.id ?? job.chapterId ?? null,
  };
}

/**
 * Creates the notification that corresponds to one generation lifecycle event.
 * Returns false when the notification already existed or the status has no
 * matching notification kind (queued/progress updates are deliberately not
 * announced as notifications).
 */
export function notifyGenerationEvent(
  job: GenerationJobRow,
  eventType: string,
  extra: { stage?: string | null; error?: string | null } = {},
): boolean {
  const kind =
    eventType === GenerationEventType.STARTED
      ? NotificationKind.STARTED
      : eventType === GenerationEventType.COMPLETED
        ? NotificationKind.COMPLETED
        : eventType === GenerationEventType.FAILED
          ? NotificationKind.FAILED
          : eventType === GenerationEventType.CANCELLED
            ? NotificationKind.CANCELLED
            : null;
  if (!kind) return false;

  const ctx = loadNotificationContext(job);
  let payload: Record<string, unknown> = {};
  try { payload = job.payload ? JSON.parse(job.payload) : {}; } catch { /* keep generic labels */ }
  const generationLabel = String((payload as any).title || (payload as any).generationType || job.taskType || 'AI content').replace(/[_-]+/g, ' ');
  const chapterLabel = ctx.chapterTitle || (job.chapterId ? 'Your chapter' : generationLabel);
  const novelLabel = ctx.novelTitle || 'your novel';

  let title: string;
  let message: string;
  switch (kind) {
    case NotificationKind.STARTED:
      title = `Generating ${chapterLabel}`;
      message = `AI generation started for “${chapterLabel}” in ${novelLabel}. You can keep using NovelForge.`;
      break;
    case NotificationKind.COMPLETED:
      title = `${chapterLabel} is ready`;
      message = job.taskType === 'chapter'
        ? 'The chapter was generated and saved. Open it to read or edit.'
        : `Your ${generationLabel} is ready. Open the project to view the result.`;
      break;
    case NotificationKind.FAILED:
      title = `Generation failed for ${chapterLabel}`;
      message = extra.error
        ? `AI generation failed: ${extra.error}`
        : 'AI generation failed. You can retry from the generation activity panel.';
      break;
    default:
      title = `Generation cancelled for ${chapterLabel}`;
      message = job.taskType === 'chapter'
        ? 'The background generation was cancelled. Existing chapter content was preserved.'
        : 'The background AI generation was cancelled.';
      break;
  }
  if (kind === NotificationKind.STARTED && extra.stage) {
    const label = stageLabel(extra.stage);
    if (label) message = `${label} — “${chapterLabel}” in ${novelLabel}. You can keep using NovelForge.`;
  }

  return createNotification({
    userId: job.userId,
    kind,
    title,
    message,
    novelId: job.novelId,
    chapterId: ctx.chapterId,
    generationJobId: job.id,
    // One notification per lifecycle event per claim. `updatedAt` is stamped
    // when the worker claims the row, so a pg-boss redelivery or worker restart
    // of the same attempt cannot duplicate a notification, while a manual retry
    // (a new claim) still reports its own outcome.
    dedupeKey: `${job.id}:${kind}:${job.attempts ?? 0}:${job.updatedAt ?? ''}`,
  });
}

export function safeNotifyGenerationEvent(
  job: GenerationJobRow,
  eventType: string,
  extra: { stage?: string | null; error?: string | null } = {},
): void {
  try {
    notifyGenerationEvent(job, eventType, extra);
  } catch (err) {
    console.error('[notifications] failed to create generation notification', err);
  }
}
