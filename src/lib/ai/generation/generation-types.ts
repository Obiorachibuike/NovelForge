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
