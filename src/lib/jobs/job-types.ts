/**
 * Background generation vocabulary.
 *
 * The database keeps NovelForge's historical lowercase job states
 * (`queued`, `processing`, `completed`, ...) because a dozen existing call
 * sites and migrations depend on them. The public background-generation API
 * and UI speak the uppercase lifecycle below; `toPublicStatus` is the single
 * translation point so the two can never drift.
 */

export const GenerationStatus = {
  NOT_STARTED: 'NOT_STARTED',
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type GenerationStatus = (typeof GenerationStatus)[keyof typeof GenerationStatus];

/** Lowercase states stored in `generation_jobs.status`. */
export type InternalJobStatus =
  | 'queued'
  | 'processing'
  | 'awaiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Real chapter-generation stages. These are transitions the worker actually
 * performs; they are not synthetic timers.
 */
export const GenerationStage = {
  PREPARING_CHAPTER: 'PREPARING_CHAPTER',
  LOADING_NOVEL_CONTEXT: 'LOADING_NOVEL_CONTEXT',
  PREPARING_AI_PROMPT: 'PREPARING_AI_PROMPT',
  CONNECTING_TO_AI_PROVIDER: 'CONNECTING_TO_AI_PROVIDER',
  GENERATING_CHAPTER_CONTENT: 'GENERATING_CHAPTER_CONTENT',
  PROCESSING_AI_RESPONSE: 'PROCESSING_AI_RESPONSE',
  VALIDATING_CHAPTER: 'VALIDATING_CHAPTER',
  SAVING_CHAPTER: 'SAVING_CHAPTER',
  COMPLETED: 'COMPLETED',
} as const;

export type GenerationStage = (typeof GenerationStage)[keyof typeof GenerationStage];

/** Human-readable stage labels shown by the global indicator and chapter list. */
export const STAGE_LABELS: Record<string, string> = {
  PREPARING_CHAPTER: 'Preparing chapter',
  LOADING_NOVEL_CONTEXT: 'Loading novel context',
  PREPARING_AI_PROMPT: 'Preparing AI prompt',
  CONNECTING_TO_AI_PROVIDER: 'Connecting to AI provider',
  GENERATING_CHAPTER_CONTENT: 'Generating chapter content',
  PROCESSING_AI_RESPONSE: 'Processing AI response',
  VALIDATING_CHAPTER: 'Validating chapter',
  SAVING_CHAPTER: 'Saving chapter',
  COMPLETED: 'Completed',
};

export function stageLabel(stage?: string | null): string | null {
  if (!stage) return null;
  return STAGE_LABELS[stage] || stage;
}

/**
 * Maps the durable job state to the public lifecycle.
 *
 * `not_started` has no job row, so callers start from the chapter's
 * `generationStatus` instead.
 */
export function toPublicStatus(status?: string | null): GenerationStatus {
  switch (status) {
    case 'queued':
      return GenerationStatus.QUEUED;
    case 'processing':
      return GenerationStatus.PROCESSING;
    case 'completed':
    case 'awaiting_review':
      return GenerationStatus.COMPLETED;
    case 'failed':
      return GenerationStatus.FAILED;
    case 'cancelled':
      return GenerationStatus.CANCELLED;
    default:
      return GenerationStatus.NOT_STARTED;
  }
}

export const ACTIVE_INTERNAL_STATUSES: InternalJobStatus[] = ['queued', 'processing'];
export const TERMINAL_INTERNAL_STATUSES: InternalJobStatus[] = [
  'completed',
  'awaiting_review',
  'failed',
  'cancelled',
];

/** Public SSE event names. */
export const GenerationEventType = {
  QUEUED: 'generation_queued',
  STARTED: 'generation_started',
  PROGRESS: 'generation_progress',
  COMPLETED: 'generation_completed',
  FAILED: 'generation_failed',
  CANCELLED: 'generation_cancelled',
  SNAPSHOT: 'generation_snapshot',
} as const;

export type GenerationEventType =
  (typeof GenerationEventType)[keyof typeof GenerationEventType];

export function isTerminalPublicStatus(status: GenerationStatus): boolean {
  return (
    status === GenerationStatus.COMPLETED ||
    status === GenerationStatus.FAILED ||
    status === GenerationStatus.CANCELLED
  );
}

/** Notification kind → the events that should create one. */
export const NotificationKind = {
  STARTED: 'generation_started',
  COMPLETED: 'generation_completed',
  FAILED: 'generation_failed',
  CANCELLED: 'generation_cancelled',
} as const;

export type NotificationKind = (typeof NotificationKind)[keyof typeof NotificationKind];

export interface GenerationJobRow {
  id: string;
  userId: string;
  novelId: string;
  chapterId?: string | null;
  taskType: string;
  payload?: string | null;
  status: InternalJobStatus;
  result?: string | null;
  error?: string | null;
  errorCode?: string | null;
  retryable?: number | null;
  attempts: number;
  maxAttempts: number;
  idempotencyKey?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string | null;
  claimedBy?: string | null;
  scheduledAt?: string | null;
  progress?: number | null;
  progressPercentage?: number | null;
  currentStage?: string | null;
  stageUpdatedAt?: string | null;
  cancelRequestedAt?: string | null;
  priority?: number | null;
  queueJobId?: string | null;
  requestedModel?: string | null;
  actualModel?: string | null;
  provider?: string | null;
  fallbackCount?: number | null;
  durationMs?: number | null;
}

/** Joined row returned by the generation API (novel + chapter titles). */
export interface GenerationWithContext extends GenerationJobRow {
  novelTitle?: string | null;
  chapterTitle?: string | null;
  chapterNumber?: number | null;
}
