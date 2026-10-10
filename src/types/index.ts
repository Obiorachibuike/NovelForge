import { z } from 'zod';

// ---------- Domain enums ----------
export const WritingMode = { CHAPTER: 'chapter', PAGE: 'page' } as const;
export const NovelStage = {
  CREATE: 'create', COVER: 'cover', PREPARE: 'prepare',
  STRUCTURE: 'structure', OUTLINE: 'outline', APPROVE: 'approve',
  WRITING: 'writing', SYNC: 'sync', CONSISTENCY: 'consistency', EXPORT: 'export',
} as const;
export const JobStatus = { QUEUED:'queued', PROCESSING:'processing', COMPLETED:'completed', FAILED:'failed', CANCELLED:'cancelled' } as const;
export const ChapterStatus = { DRAFT:'draft', GENERATED:'generated', EDITED:'edited', APPROVED:'approved', LOCKED:'locked' } as const;
export const IssueSeverity = { INFO:'info', WARNING:'warning', ERROR:'error' } as const;

// ---------- Validators ----------
export const createNovelSchema = z.object({
  title: z.string().min(1, 'Title is required').max(120),
  premise: z.string().max(2000).optional().or(z.literal('')),
  genre: z.string().default('Fantasy'),
  tone: z.string().max(120).optional().or(z.literal('')),
  style: z.string().max(120).optional().or(z.literal('')),
  pov: z.string().default('Third Person Limited'),
  audience: z.string().max(80).optional().or(z.literal('')),
  targetWords: z.coerce.number().int().min(1000).max(500000).default(80000),
  targetPages: z.coerce.number().int().min(5).max(2000).default(250),
  targetChapters: z.coerce.number().int().min(1).max(100).default(30),
  writingMode: z.enum(['chapter','page']).default('chapter'),
});
export type CreateNovelInput = z.infer<typeof createNovelSchema>;

export const novelSettingsSchema = z.object({
  fontFamily: z.string().default('serif'),
  fontSize: z.coerce.number().int().min(8).max(24).default(12),
  lineSpacing: z.coerce.number().min(1).max(3).default(1.6),
  margin: z.coerce.number().int().min(36).max(144).default(72),
  pageSize: z.enum(['letter','a5','a4','trade']).default('letter'),
  chapterHeadingStyle: z.enum(['centered','left','numbered','plain']).default('centered'),
  pageNumbering: z.enum(['bottom-center','top-right','none']).default('bottom-center'),
  includeFrontMatter: z.coerce.boolean().default(true),
  includeToc: z.coerce.boolean().default(true),
  coverPlacement: z.enum(['front','none']).default('front'),
  wordsPerPage: z.coerce.number().int().min(200).max(500).default(320),
});
export type NovelSettingsInput = z.infer<typeof novelSettingsSchema>;

export const prepareSchema = z.object({ sections: z.array(z.string()).optional() });
export const outlineSchema = z.object({
  structure: z.enum(['three-act','five-act','heros-journey','custom']).default('three-act'),
});
export const coverGenerateSchema = z.object({ prompt: z.string().min(3).max(500), variants: z.coerce.number().int().min(1).max(4).default(2) });
export const coverSelectSchema = z.object({ imageId: z.string().min(1) });
export const chapterGenerateSchema = z.object({ chapterId: z.string().optional(), chapterNumber: z.coerce.number().int().min(1).optional() });
export const chapterApproveSchema = z.object({});
export const editorActionSchema = z.object({
  action: z.enum(['continue','rewrite','expand','shorten','improve','dialogue','tone','continuity','alt-scene']),
  selection: z.string().max(10000).optional(),
  chapterId: z.string(),
  before: z.string().max(2000).optional(),
  after: z.string().max(2000).optional(),
});
export const exportSchema = z.object({
  format: z.enum(['pdf','docx','epub','txt','markdown']),
  options: novelSettingsSchema.partial().optional(),
});

// ---------- Domain types ----------
export interface UserRow {
  id: string; name: string|null; email: string|null; image: string|null;
  passwordHash: string|null; emailVerified?: string|null; createdAt: string; updatedAt: string;
}
export interface NovelRow {
  id: string; userId: string; title: string; premise: string|null; genre: string;
  tone: string|null; style: string|null; pov: string; audience: string|null;
  targetWords: number; targetPages: number; targetChapters: number;
  writingMode: 'chapter'|'page'; status: string; stage: string;
  coverImageId: string|null; createdAt: string; updatedAt: string;
  approvedAt: string|null; completedAt: string|null;
}
export interface NovelSettingsRow {
  id: string; novelId: string; fontFamily: string; fontSize: number; lineSpacing: number;
  margin: number; pageSize: string; chapterHeadingStyle: string; pageNumbering: string;
  includeFrontMatter: boolean; includeToc: boolean; coverPlacement: string; wordsPerPage: number;
}
export interface ImageAssetRow {
  id: string; novelId: string|null; userId: string; kind: string; provider: string;
  storageKey: string; url: string; width: number|null; height: number|null;
  prompt: string|null; isPrimary: number; meta: string|null; createdAt: string;
}
export interface PremiseRow {
  id: string; novelId: string; logline: string|null; shortSynopsis: string|null;
  fullSynopsis: string|null; themes: string|null; setting: string|null; majorConflicts: string|null;
  createdAt: string; updatedAt: string;
}
export interface StoryBibleRow { id:string; novelId:string; overview:string|null; toneNotes:string|null; styleGuide:string|null; createdAt:string; updatedAt:string; }
export interface CharacterRow {
  id: string; novelId: string; name: string; role: string; age: string|null; appearance: string|null;
  personality: string|null; motivation: string|null; goals: string|null; fears: string|null;
  arc: string|null; backstory: string|null; avatarId: string|null; meta: string|null; createdAt: string; updatedAt: string;
}
export interface LocationRow { id:string; novelId:string; name:string; description:string|null; kind:string|null; imageId:string|null; meta:string|null; createdAt:string; updatedAt:string; }
export interface WorldRuleRow { id:string; novelId:string; name:string; description:string; category:string|null; createdAt:string; updatedAt:string; }
export interface TimelineEventRow { id:string; novelId:string; chapterId:string|null; label:string; description:string; when:string|null; orderIndex:number; createdAt:string; }
export interface PlotThreadRow { id:string; novelId:string; title:string; description:string; status:string; introducedInChapterId:string|null; resolvedInChapterId:string|null; createdAt:string; updatedAt:string; }
export interface StoryActRow { id:string; novelId:string; actNumber:number; name:string; description:string|null; purpose:string|null; turningPoint:string|null; orderIndex:number; }
export interface ChapterOutlineRow {
  id:string; novelId:string; actId:string|null; chapterNumber:number; title:string; summary:string|null;
  narrativePurpose:string|null; majorEvents:string|null; charactersInvolved:string|null; location:string|null;
  conflict:string|null; emotionalObjective:string|null; plotAdvancement:string|null; foreshadowing:string|null;
  targetWords:number; estimatedPages:number; status:string; orderIndex:number;
}
export interface ChapterRow {
  id:string; novelId:string; outlineId:string|null; chapterNumber:number; title:string;
  contentJson:string; contentHtml:string|null; plainText:string|null;
  status:string; wordCount:number; pageCountEst:number; summary:string|null; importantEvents:string|null;
  currentVersionId:string|null; createdAt:string; updatedAt:string; approvedAt:string|null;
}
export interface ChapterVersionRow { id:string; chapterId:string; versionNum:number; contentJson:string; wordCount:number; note:string|null; createdAt:string; }
export interface ChapterMemoryRow { id:string; novelId:string; chapterId:string|null; characterId:string|null; kind:string; content:string; importance:number; embedding:string|null; meta:string|null; createdAt:string; }
export interface GenerationJobRow {
  id:string; userId:string; novelId:string; taskType:string; payload:string; status:string;
  result:string|null; error:string|null; attempts:number; maxAttempts:number; idempotencyKey:string|null;
  startedAt:string|null; completedAt:string|null; createdAt:string; updatedAt:string;
}
export interface ConsistencyIssueRow {
  id:string; novelId:string; chapterId:string|null; kind:string; severity:string; title:string;
  description:string; evidence:string|null; suggestion:string|null; status:string; meta:string|null;
  createdAt:string; updatedAt:string;
}
export interface ExportRow {
  id:string; userId:string; novelId:string; format:string; status:string; fileKey:string|null;
  fileUrl:string|null; fileSize:number|null; options:string|null; error:string|null;
  createdAt:string; completedAt:string|null;
}

export interface CharacterRelationshipRow { id:string; novelId:string; fromId:string; toId:string; relation:string; description:string|null; }
export interface SessionRow { id:string; sessionToken:string; userId:string; expires:string; }
export interface AccountRow { id:string; userId:string; type:string; provider:string; providerAccountId:string; refresh_token:string|null; access_token:string|null; expires_at:number|null; token_type:string|null; scope:string|null; id_token:string|null; session_state:string|null; }

// ---------- AI Types ----------
export interface ChatMessage { role: 'system'|'user'|'assistant'; content: string; }
export interface StreamChunk { type: 'text'|'usage'|'done'; text?: string; usage?: { promptTokens:number; completionTokens:number; model:string; }; }
export interface GenerationTask {
  type: 'cover'|'premise'|'bible'|'outline'|'chapter'|'memory'|'embedding'|'consistency'|'export';
  novelId: string; userId: string; payload: Record<string,unknown>;
  idempotencyKey?: string;
}

// Word count helper
export function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}
