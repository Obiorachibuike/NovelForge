import 'server-only';
import { getDb } from '@/lib/db';
import { HttpError } from '@/lib/api/http';
import { cancelJob, retryJob } from '@/lib/queue';
import { enqueueChapterGeneration } from '@/services/chapters/service';
import {
  GenerationStatus,
  stageLabel,
  toPublicStatus,
  type GenerationWithContext,
} from './job-types';

/**
 * Background-generation application service.
 *
 * Route handlers stay thin: authentication and ownership happen here and in
 * `requireUser`/`requireNovel`, and all status translation to the public
 * uppercase lifecycle happens in one place.
 */

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function maxActiveGenerationsPerUser(): number {
  return envInt('GENERATION_MAX_ACTIVE_PER_USER', 3);
}

export function maxActiveGenerationsPerNovel(): number {
  return envInt('GENERATION_MAX_ACTIVE_PER_NOVEL', 1);
}

const GENERATION_SELECT = `
  SELECT j.*, n.title AS novelTitle, c.title AS chapterTitle, c.chapterNumber AS chapterNumber
    FROM generation_jobs j
    LEFT JOIN novels n ON n.id = j.novelId
    LEFT JOIN chapters c ON c.id = j.chapterId
`;

export interface ListGenerationOptions {
  active?: boolean;
  novelId?: string;
  chapterId?: string;
  limit?: number;
}

/** The caller's own generation history / active jobs. Never cross-user. */
export function listGenerations(userId: string, options: ListGenerationOptions = {}): GenerationWithContext[] {
  const db = getDb();
  const clauses = ['j.userId = ?', `j.taskType = 'chapter'`];
  const args: unknown[] = [userId];
  if (options.active) {
    clauses.push(`j.status IN ('queued','processing')`);
  }
  if (options.novelId) {
    clauses.push('j.novelId = ?');
    args.push(options.novelId);
  }
  if (options.chapterId) {
    clauses.push('j.chapterId = ?');
    args.push(options.chapterId);
  }
  const limit = Math.min(100, Math.max(1, options.limit ?? 25));
  return db
    .prepare(`${GENERATION_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY j.createdAt DESC LIMIT ?`)
    .all(...args, limit) as GenerationWithContext[];
}

export function getGenerationForUser(userId: string, jobId: string): GenerationWithContext | undefined {
  const db = getDb();
  return db
    .prepare(`${GENERATION_SELECT} WHERE j.id = ? AND j.userId = ?`)
    .get(jobId, userId) as GenerationWithContext | undefined;
}

/** Latest generation attempt for each chapter in a novel (used by the UI). */
export function latestGenerationsForNovel(userId: string, novelId: string): GenerationWithContext[] {
  const db = getDb();
  return db
    .prepare(
      `${GENERATION_SELECT}
        WHERE j.userId = ? AND j.novelId = ? AND j.taskType = 'chapter'
          AND j.createdAt = (
            SELECT MAX(j2.createdAt) FROM generation_jobs j2
             WHERE j2.chapterId = j.chapterId AND j2.userId = j.userId
          )
        ORDER BY j.createdAt DESC`,
    )
    .all(userId, novelId) as GenerationWithContext[];
}

export function serializeGeneration(job: GenerationWithContext) {
  const status = toPublicStatus(job.status);
  const isChapterJob = job.taskType === 'chapter';
  return {
    id: job.id,
    novelId: job.novelId,
    novelTitle: job.novelTitle ?? null,
    chapterId: job.chapterId ?? null,
    chapterTitle: job.chapterTitle ?? null,
    chapterNumber: job.chapterNumber ?? null,
    taskType: job.taskType,
    status,
    /**
     * Chapter generation is stage-based: providers do not expose real
     * percentage progress, so this stays null and the client renders an
     * indeterminate indicator rather than a fabricated number.
     */
    progressPercentage: job.progressPercentage ?? null,
    indeterminate: isChapterJob && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(status),
    currentStage: job.currentStage ?? null,
    currentStageLabel: stageLabel(job.currentStage),
    errorMessage: job.error ? String(job.error) : null,
    errorCode: job.errorCode ?? null,
    retryCount: job.attempts ?? 0,
    maxAttempts: job.maxAttempts ?? 3,
    canCancel: ['QUEUED', 'PROCESSING'].includes(status),
    canRetry: ['FAILED', 'CANCELLED'].includes(status),
    retryable: job.retryable === undefined || job.retryable === null ? true : Boolean(job.retryable),
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    partialText: (() => {
      // Keep whatever prose the provider produced, including after a failure
      // or a cancellation, so the author never loses usable text.
      if (!job.result) return null;
      try {
        const parsed = JSON.parse(job.result);
        return typeof parsed?.partialText === 'string' ? parsed.partialText.slice(-6000) : null;
      } catch {
        return null;
      }
    })(),
    requestedModel: job.requestedModel ?? null,
    actualModel: job.actualModel ?? null,
    provider: job.provider ?? null,
    eventsUrl: `/api/generations/${job.id}/events`,
  };
}

export interface CreateGenerationInput {
  novelId: string;
  chapterId?: string;
  chapterNumber?: number;
  confirmOverwrite?: boolean;
  textModel?: string;
  allowFallback?: boolean;
}

/**
 * Creates one background chapter generation.
 *
 * Ownership, the sequential-writing gate, duplicate prevention and the
 * per-user/novel limits all live in `enqueueChapterGeneration`, the existing
 * NovelForge implementation — this function only resolves which chapter.
 */
export async function createChapterGeneration(userId: string, input: CreateGenerationInput) {
  const db = getDb();
  const novel = db.prepare('SELECT id FROM novels WHERE id=? AND userId=?').get(input.novelId, userId);
  if (!novel) throw new HttpError(404, 'Novel not found', 'novel_not_found');

  let chapterNumber = input.chapterNumber ?? null;
  if (!chapterNumber && input.chapterId) {
    const chapter = db
      .prepare('SELECT chapterNumber FROM chapters WHERE id=? AND novelId=?')
      .get(input.chapterId, input.novelId) as { chapterNumber: number } | undefined;
    const outline = chapter
      ? undefined
      : (db
          .prepare('SELECT chapterNumber FROM chapter_outlines WHERE id=? AND novelId=?')
          .get(input.chapterId, input.novelId) as { chapterNumber: number } | undefined);
    chapterNumber = chapter?.chapterNumber ?? outline?.chapterNumber ?? null;
    if (!chapterNumber) throw new HttpError(404, 'Chapter not found', 'chapter_not_found');
  }

  if (!chapterNumber) {
    const outlines = db
      .prepare('SELECT chapterNumber FROM chapter_outlines WHERE novelId=? ORDER BY chapterNumber')
      .all(input.novelId) as { chapterNumber: number }[];
    const chapters = db
      .prepare('SELECT chapterNumber,status FROM chapters WHERE novelId=?')
      .all(input.novelId) as { chapterNumber: number; status: string }[];
    const approved = new Set(chapters.filter(c => c.status === 'approved').map(c => c.chapterNumber));
    const next = outlines.find(o => !approved.has(o.chapterNumber));
    chapterNumber = next?.chapterNumber ?? null;
    if (!chapterNumber) {
      throw new HttpError(409, 'Every scheduled chapter has already been approved.', 'nothing_to_write');
    }
  }

  const jobId = await enqueueChapterGeneration(userId, input.novelId, chapterNumber, {
    confirmOverwrite: input.confirmOverwrite,
    ...(input.textModel && input.textModel !== 'auto' ? { textModel: input.textModel } : {}),
    allowFallback: input.allowFallback,
  });

  const job = getGenerationForUser(userId, jobId);
  if (!job) {
    // Extremely unlikely: the row was inserted and immediately deleted.
    throw new HttpError(500, 'Generation job could not be loaded.', 'generation_missing');
  }
  return { jobId, chapterNumber, generation: serializeGeneration(job) };
}

export async function cancelGeneration(userId: string, jobId: string) {
  const job = getGenerationForUser(userId, jobId);
  if (!job) throw new HttpError(404, 'Generation not found', 'generation_not_found');
  if (!['QUEUED', 'PROCESSING'].includes(toPublicStatus(job.status))) {
    throw new HttpError(409, 'This generation is no longer active and cannot be cancelled.', 'generation_not_cancellable');
  }
  const cancelled = cancelJob(jobId);
  if (!cancelled) {
    throw new HttpError(409, 'This generation is no longer active and cannot be cancelled.', 'generation_not_cancellable');
  }
  const updated = getGenerationForUser(userId, jobId);
  return updated ? serializeGeneration(updated) : null;
}

export async function retryGeneration(userId: string, jobId: string) {
  const job = getGenerationForUser(userId, jobId);
  if (!job) throw new HttpError(404, 'Generation not found', 'generation_not_found');
  if (!['FAILED', 'CANCELLED'].includes(toPublicStatus(job.status))) {
    throw new HttpError(409, 'Only failed or cancelled generations can be retried.', 'generation_not_retryable');
  }
  const retried = await retryJob(jobId);
  if (!retried) {
    throw new HttpError(409, 'Only failed or cancelled generations can be retried.', 'generation_not_retryable');
  }
  const updated = getGenerationForUser(userId, jobId);
  return updated ? serializeGeneration(updated) : null;
}

/** Snapshot used by the SSE stream before replaying persisted events. */
export function generationSnapshot(job: GenerationWithContext) {
  return {
    ...serializeGeneration(job),
    type: 'generation_snapshot',
  };
}

/** A chapter with no job row at all. */
export function notStartedGeneration(chapterId: string, novelId: string) {
  return {
    id: null,
    novelId,
    chapterId,
    status: GenerationStatus.NOT_STARTED,
    progressPercentage: null,
    indeterminate: false,
    currentStage: null,
    currentStageLabel: null,
  };
}
