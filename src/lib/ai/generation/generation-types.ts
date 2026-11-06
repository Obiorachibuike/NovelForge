import 'server-only';
import { z } from 'zod';

/**
 * The universal generation vocabulary.
 *
 * `GENERATION_TYPE_VALUES` is the single source of truth: the TypeScript union
 * is derived from it and `GenerationRequestSchema` validates against it, so the
 * compiler and the runtime validator can never disagree about which generation
 * types exist.
 *
 * Adding a feature = adding one entry here (and, optionally, a handler through
 * `GenerationRegistry`). Callers that need a type this list does not describe
 * use `'custom'` plus a `customType` label (see `GenerationRequestSchema`),
 * which keeps validation strict instead of degrading every type to `string`.
 */
export const GENERATION_TYPE_VALUES = [
  // Novel-level documents
  'novel_title',
  'novel_description',
  'novel_summary',
  'story_idea',
  'story_outline',
  'chapter_outline',
  'premise',
  'outline',
  'book_blurb',
  'author_bio',
  'marketing_copy',
  // Prose and units of a manuscript
  'chapter',
  'page',
  'scene',
  'memory',
  // Story bible
  'character',
  'character_backstory',
  'character_relationship',
  'worldbuilding',
  'location',
  'culture',
  'history',
  // Text transformations
  'rewrite',
  'expand',
  'summarize',
  'shorten',
  'proofread',
  'humanize',
  // Media
  'image',
  // Deliberate extension point
  'custom',
] as const;

export type GenerationType = (typeof GENERATION_TYPE_VALUES)[number];

/** Marker prefix for a caller-supplied generation type. */
export const CUSTOM_GENERATION_PREFIX = 'custom:';

/** Hard ceiling on the prompt a client may submit (characters). */
export const MAX_PROMPT_CHARS = 100_000;

/** Hard ceiling on the serialised `context` payload (characters). */
export const MAX_CONTEXT_CHARS = 200_000;

const GENERATION_TYPE_SET: ReadonlySet<string> = new Set(GENERATION_TYPE_VALUES);

/** Runtime guard: is this string one of the supported generation types? */
export function isGenerationType(value: unknown): value is GenerationType {
  return typeof value === 'string' && GENERATION_TYPE_SET.has(value);
}

/**
 * Normalises a caller/provider type string into a `GenerationType`.
 * Returns `null` (never a guess) for anything unsupported.
 */
export function parseGenerationType(value: unknown): GenerationType | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (isGenerationType(trimmed)) return trimmed;
  if (trimmed.startsWith(CUSTOM_GENERATION_PREFIX) && trimmed.length > CUSTOM_GENERATION_PREFIX.length) {
    return 'custom';
  }
  return null;
}

/** Providers the universal engine can route to, in priority order. */
export const GENERATION_PROVIDERS = ['agnes', 'huggingface', 'openai'] as const;
export type GenerationProvider = (typeof GENERATION_PROVIDERS)[number];

export function isGenerationProvider(value: unknown): value is GenerationProvider {
  return typeof value === 'string' && (GENERATION_PROVIDERS as readonly string[]).includes(value);
}

/** Human labels used by stages, logs and the UI. */
export const GENERATION_TYPE_LABELS: Record<GenerationType, string> = {
  novel_title: 'Novel title',
  novel_description: 'Novel description',
  novel_summary: 'Novel summary',
  story_idea: 'Story idea',
  story_outline: 'Story outline',
  chapter_outline: 'Chapter outline',
  premise: 'Premise',
  outline: 'Outline',
  book_blurb: 'Book blurb',
  author_bio: 'Author biography',
  marketing_copy: 'Marketing copy',
  chapter: 'Chapter',
  page: 'Page',
  scene: 'Scene',
  memory: 'Story memory',
  character: 'Character',
  character_backstory: 'Character backstory',
  character_relationship: 'Character relationship',
  worldbuilding: 'Worldbuilding',
  location: 'Location',
  culture: 'Culture',
  history: 'History',
  rewrite: 'Rewrite',
  expand: 'Expansion',
  summarize: 'Summary',
  shorten: 'Shortened text',
  proofread: 'Proofread text',
  humanize: 'Humanized text',
  image: 'Image',
  custom: 'Custom generation',
};

/**
 * Per-type instruction used by the generic text path. Types with a dedicated
 * service (chapter, outline, premise, memory, image) are executed by that
 * service through the queue, so their entries here are only fallbacks.
 */
export const GENERATION_TYPE_INSTRUCTIONS: Record<GenerationType, string> = {
  novel_title: 'Produce a single evocative novel title. No quotation marks, no commentary.',
  novel_description: 'Write a compelling back-cover description (120-200 words).',
  novel_summary: 'Write a concise summary of the novel (150-250 words).',
  story_idea: 'Propose a distinctive, commercially viable story idea and explain its hook.',
  story_outline: 'Produce a structured act-and-chapter outline for the novel.',
  chapter_outline: 'Produce a detailed outline for one chapter: purpose, beats, conflict, and ending hook.',
  premise: 'Write a full story premise: logline, synopsis, themes, setting and major conflicts.',
  outline: 'Produce a structured outline for the requested material.',
  book_blurb: 'Write a short marketing blurb suitable for retail listings.',
  author_bio: 'Write a third-person author biography (80-150 words).',
  marketing_copy: 'Write launch marketing copy with a headline, body and call to action.',
  chapter: 'Write the requested chapter as continuous prose.',
  page: 'Write the requested page of prose.',
  scene: 'Write the requested scene with clear staging and dialogue.',
  memory: 'Extract durable story facts (events, characters, threads, world rules) as JSON.',
  character: 'Create a character profile: role, appearance, personality, motivation, goal, fear and arc.',
  character_backstory: 'Write the character’s backstory as prose consistent with the established canon.',
  character_relationship: 'Describe the relationship between the named characters, including tension and history.',
  worldbuilding: 'Describe the world: rules, factions, technology or magic, and constraints.',
  location: 'Describe the location: geography, atmosphere, sensory detail and narrative use.',
  culture: 'Describe the culture: customs, beliefs, language, taboos and social structure.',
  history: 'Describe the relevant history as a coherent account with dates and consequences.',
  rewrite: 'Rewrite the supplied text, preserving meaning while improving the prose.',
  expand: 'Expand the supplied text with additional detail, keeping voice and continuity.',
  summarize: 'Summarise the supplied text.',
  shorten: 'Shorten the supplied text without losing key information.',
  proofread: 'Correct grammar, spelling and punctuation; change nothing else.',
  humanize: 'Rewrite the supplied text so it reads as natural, human prose.',
  image: 'Describe the image to generate from the supplied prompt.',
  custom: 'Complete the requested generation task exactly as specified.',
};

/** What the caller asks the engine to generate. */
export interface GenerationRequest {
  /** The novel/project the generation belongs to (never a job id). */
  projectId: string;
  /** The owning user. */
  userId: string;

  generationType: GenerationType;
  /** Required when `generationType` is `'custom'`. */
  customType?: string;

  /** e.g. 'chapter', 'outline', 'premise' — what `targetId` points at. */
  targetType?: string;
  /** e.g. chapterId, outlineId. Never a generation job id. */
  targetId?: string;

  prompt: string;
  context?: Record<string, unknown>;

  /** 'agnes' (default), 'huggingface' or 'openai'. */
  provider?: GenerationProvider;
  model?: string;

  /** Ask for incremental provider streaming (text types only). */
  stream?: boolean;

  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

/** One persisted incremental chunk of generated text. */
export interface GenerationChunk {
  /** Monotonic within a job; used to de-duplicate replayed chunks. */
  sequence: number;
  /** The new text carried by this chunk (a delta, never the whole text). */
  content: string;
  /** Cumulative length of the text after this chunk. */
  totalLength?: number;
  isComplete?: boolean;
  error?: string;
}

/** Provenance of a generated result. Never fabricated. */
export interface GenerationResultMeta {
  source: 'agnes' | 'huggingface' | 'openai' | 'demo' | 'fallback';
  model: string;
  actualModel?: string;
  provider?: string;
  usedFallback: boolean;
  fallbackReason?: string;
  attempts?: number;
  latencyMs?: number;
  usage?: Record<string, unknown>;
  cost?: Record<string, unknown>;
}

export interface GenerationResult {
  text?: string;
  structuredData?: Record<string, unknown>;
  /** Extra, type-specific artefacts (an image URL, a stored asset id, ...). */
  assets?: Record<string, unknown>;
  meta: GenerationResultMeta;
  /** Set by handlers that write a reviewable draft instead of final content. */
  awaitingReview?: boolean;
  /**
   * Set by handlers that already persisted their own side effects (chapter
   * rows, cover assets, ...) so the worker can record the referenced row.
   */
  chapterId?: string;
}

/** Stage/progress/cancel surface handed to an executing engine or handler. */
export interface GenerationExecutionContext {
  setStage: (stage: string, data?: Record<string, unknown>) => void;
  setProgress: (percent: number) => void;
  isCancelled: () => boolean;
  /** Aborted as soon as the job is cancelled, so provider calls can stop. */
  signal: AbortSignal;
}

/**
 * A registered generation handler.
 *
 * Handlers receive the validated request and the execution context, and either
 * return a `GenerationResult` or any JSON-serialisable value (which is wrapped
 * as `structuredData`). They must not finalise the job: the worker owns
 * finalisation so there is exactly one owner.
 */
export type GenerationHandler = (
  request: GenerationRequest,
  context: GenerationExecutionContext,
) => Promise<unknown>;

const contextRecord = z.record(z.unknown());

/**
 * Validation schema for job creation. Mirrors `GenerationRequest` exactly
 * (the type is derived from the schema's input, see `GenerationRequestInput`).
 */
const GenerationRequestObject = z.object({
  projectId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
  generationType: z.enum(GENERATION_TYPE_VALUES),
    customType: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/, 'customType must be a slug')
      .optional(),
  targetType: z.string().min(1).max(64).optional(),
  targetId: z.string().min(1).max(128).optional(),
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  context: contextRecord.optional(),
  provider: z.enum(GENERATION_PROVIDERS).optional(),
  model: z.string().min(1).max(200).optional(),
  stream: z.boolean().optional(),
  metadata: contextRecord.optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

/** Shared cross-field rules (used by both the HTTP and the internal schema). */
function refineGenerationRequest(
  value: z.infer<typeof GenerationRequestObject>,
  ctx: z.RefinementCtx,
) {
    if (value.generationType === 'custom' && !value.customType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customType'],
        message: 'customType is required when generationType is "custom".',
      });
    }
  if (value.context) {
    let size = 0;
    try {
      size = JSON.stringify(value.context).length;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['context'],
        message: 'context must be JSON-serialisable.',
      });
      return;
    }
    if (size > MAX_CONTEXT_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['context'],
        message: `context must be smaller than ${MAX_CONTEXT_CHARS} characters.`,
      });
    }
  }
}

/** The internal, fully-populated request (always carries the owner). */
export const GenerationRequestSchema = GenerationRequestObject.superRefine(refineGenerationRequest);

export type GenerationRequestInput = z.input<typeof GenerationRequestSchema>;

/** The event payload contract shared by the persisted store and SSE route. */
export interface GenerationEventPayload {
  sequence: number;
  eventType:
    | 'queued'
    | 'started'
    | 'progress'
    | 'content'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'snapshot';
  content?: string;
  metadata?: Record<string, unknown>;
  stage?: string;
  stageLabel?: string;
  status?: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
}
