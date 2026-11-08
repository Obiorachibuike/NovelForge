import 'server-only';
import { z } from 'zod';

/**
 * Extensible generation types.
 * Do not hardcode these as a limit; allow registration.
 */
export type GenerationType =
  | 'novel_title'
  | 'novel_description'
  | 'novel_summary'
  | 'story_idea'
  | 'story_outline'
  | 'chapter_outline'
  | 'chapter'
  | 'page'
  | 'scene'
  | 'character'
  | 'character_backstory'
  | 'character_relationship'
  | 'worldbuilding'
  | 'location'
  | 'culture'
  | 'history'
  | 'book_blurb'
  | 'author_bio'
  | 'marketing_copy'
  | 'rewrite'
  | 'expand'
  | 'summarize'
  | 'shorten'
  | 'proofread'
  | 'humanize'
  | 'custom'
  | 'premise'
  | 'outline'
  | 'chapter'
  | 'memory'
  | 'image';

export interface GenerationRequest {
  projectId: string; // novelId
  userId: string;

  generationType: GenerationType;

  targetType?: string; // e.g., 'chapter', 'outline', 'premise'
  targetId?: string;   // e.g., chapterId, outlineId

  prompt: string;
  context?: Record<string, unknown>;

  provider?: string;   // 'agnes', 'huggingface', 'openai'
  model?: string;

  stream?: boolean;    // True for text generation streaming

  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface GenerationChunk {
  sequence: number;
  content: string;
  isComplete?: boolean;
  error?: string;
}

/**
 * Runtime context handed to a registered handler by `executeJob`.
 *
 * It mirrors the queue's `JobHandlerContext`: the durable job id, the parsed
 * job payload, and the cooperative-cancellation primitives. Handlers must use
 * `jobId` (never `projectId`) when they persist or finalize job state.
 */
export interface GenerationExecutionContext {
  /** The `generation_jobs` row this execution belongs to. */
  jobId: string;
  userId: string;
  /** Novel id (`generation_jobs.novelId`). */
  projectId: string;
  /** Chapter/outline/asset id when the job targets one. */
  targetId?: string | null;
  /** The durable job payload, already parsed. */
  payload: Record<string, unknown>;
  /** Persists a stage and publishes a `generation_progress` event. */
  setStage: (stage: string, data?: Record<string, unknown>) => void;
  setProgress: (percent: number) => void;
  isCancelled: () => boolean;
  signal: AbortSignal;
}

/** A handler registered for one `GenerationType`. */
export type GenerationHandler = (
  request: GenerationRequest,
  context: GenerationExecutionContext,
) => Promise<unknown>;

/**
 * Job payloads are JSON round-tripped through the database, so every field is
 * `unknown` at the edges. These readers keep the coercion in one place instead
 * of scattering casts through call sites.
 */
export function payloadString(
  payload: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function payloadNumber(
  payload: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = payload?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function payloadBoolean(
  payload: Record<string, unknown> | null | undefined,
  key: string,
): boolean | undefined {
  const value = payload?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function payloadRecord(
  payload: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> {
  const value = payload?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface GenerationResult {
  text?: string;
  structuredData?: Record<string, unknown>;
  meta: {
    source: 'agnes' | 'huggingface' | 'openai' | 'demo' | 'fallback';
    model: string;
    actualModel?: string;
    provider?: string;
    usedFallback: boolean;
    fallbackReason?: string;
    attempts: number;
    latencyMs: number;
    usage?: Record<string, unknown>;
    cost?: Record<string, unknown>;
  };
}

// Validation schema for creation
export const GenerationRequestSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
  generationType: z.enum([
    'novel_title', 'novel_description', 'novel_summary', 'story_idea', 'story_outline',
    'chapter_outline', 'chapter', 'page', 'scene', 'character', 'character_backstory',
    'character_relationship', 'worldbuilding', 'location', 'culture', 'history',
    'book_blurb', 'author_bio', 'marketing_copy', 'rewrite', 'expand', 'summarize',
    'shorten', 'proofread', 'humanize', 'custom', 'premise', 'outline', 'memory', 'image'
  ]),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  prompt: z.string().min(1),
  context: z.record(z.unknown()).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  stream: z.boolean().optional().default(false),
  metadata: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().optional(),
});

export interface GenerationEventPayload {
  sequence: number;
  eventType:
    | 'queued'
    | 'started'
    | 'progress'
    | 'content'
    | 'completed'
    | 'failed'
    | 'cancelled';
  content?: string;
  metadata?: Record<string, unknown>;
  stage?: string;
  stageLabel?: string;
  status?: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
}
