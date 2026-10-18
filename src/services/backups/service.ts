import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { readFile, saveFile } from '@/lib/storage';
import { HttpError } from '@/lib/api/http';
import 'server-only';

export const BACKUP_FORMAT = 'novelforge-backup' as const;
export const BACKUP_FORMAT_VERSION = 1 as const;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  createdAt: string;
  novelId: string;
  novelTitle: string;
  checksum: string;
  counts: {
    chapters: number;
    chapterVersions: number;
    outlines: number;
    characters: number;
    locations: number;
    worldRules: number;
    timelineEvents: number;
    plotThreads: number;
    memories: number;
    coverAssets: number;
  };
}

export interface NovelBackupBundle {
  manifest: BackupManifest;
  data: {
    novel: Record<string, any>;
    settings: Record<string, any> | null;
    premise: Record<string, any> | null;
    storyBible: Record<string, any> | null;
    characters: Array<Record<string, any>>;
    characterRelationships: Array<Record<string, any>>;
    locations: Array<Record<string, any>>;
    worldRules: Array<Record<string, any>>;
    storyActs: Array<Record<string, any>>;
    chapterOutlines: Array<Record<string, any>>;
    chapters: Array<Record<string, any>>;
    chapterVersions: Array<Record<string, any>>;
    timelineEvents: Array<Record<string, any>>;
    plotThreads: Array<Record<string, any>>;
    chapterMemories: Array<Record<string, any>>;
    consistencyIssues: Array<Record<string, any>>;
    coverAssets: Array<Record<string, any>>;
  };
}

const backupDataSchema = z.object({
  novel: z.object({
    id: z.string().min(1).max(64).optional(),
    title: z.string().min(1).max(200),
    premise: z.string().nullable().optional(),
    genre: z.string().max(120).optional().default('Fantasy'),
    tone: z.string().nullable().optional(),
    style: z.string().nullable().optional(),
    pov: z.string().max(120).optional().default('Third Person Limited'),
    audience: z.string().nullable().optional(),
    targetWords: z.number().int().min(100).max(1_000_000).optional().default(80000),
    targetPages: z.number().int().min(1).max(10_000).optional().default(250),
    targetChapters: z.number().int().min(1).max(500).optional().default(30),
    writingMode: z.enum(['chapter', 'page']).optional().default('chapter'),
    status: z.string().max(64).optional().default('draft'),
    stage: z.string().max(64).optional().default('create'),
    coverImageId: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    approvedAt: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
  }),
  settings: z.record(z.any()).nullable().optional(),
  premise: z.record(z.any()).nullable().optional(),
  storyBible: z.record(z.any()).nullable().optional(),
  characters: z.array(z.record(z.any())).optional().default([]),
  characterRelationships: z.array(z.record(z.any())).optional().default([]),
  locations: z.array(z.record(z.any())).optional().default([]),
  worldRules: z.array(z.record(z.any())).optional().default([]),
  storyActs: z.array(z.record(z.any())).optional().default([]),
  chapterOutlines: z.array(z.record(z.any())).optional().default([]),
  chapters: z.array(z.object({
    id: z.string().min(1).max(64).optional(),
    outlineId: z.string().nullable().optional(),
    chapterNumber: z.number().int().min(1).max(1000),
    title: z.string().min(1).max(300),
    contentJson: z.string(),
    generatedContentJson: z.string().nullable().optional(),
    contentHtml: z.string().nullable().optional(),
    plainText: z.string().nullable().optional(),
    status: z.string().optional().default('draft'),
    wordCount: z.number().int().min(0).optional().default(0),
    pageCountEst: z.number().int().min(0).optional().default(1),
    summary: z.string().nullable().optional(),
    importantEvents: z.string().nullable().optional(),
    currentVersionId: z.string().nullable().optional(),
    revision: z.number().int().min(1).optional().default(1),
    generationSource: z.string().nullable().optional(),
    generatedAt: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    approvedAt: z.string().nullable().optional(),
  })).optional().default([]),
  chapterVersions: z.array(z.record(z.any())).optional().default([]),
  timelineEvents: z.array(z.record(z.any())).optional().default([]),
  plotThreads: z.array(z.record(z.any())).optional().default([]),
  chapterMemories: z.array(z.record(z.any())).optional().default([]),
  consistencyIssues: z.array(z.record(z.any())).optional().default([]),
  coverAssets: z.array(z.record(z.any())).optional().default([]),
});

const backupBundleSchema = z.object({
  manifest: z.object({
    format: z.literal(BACKUP_FORMAT),
    formatVersion: z.number().int(),
    createdAt: z.string().min(1),
    novelId: z.string().min(1),
    novelTitle: z.string().min(1),
    checksum: z.string().min(16),
    counts: z.record(z.number()).optional(),
  }),
  data: backupDataSchema,
});

/** Deterministic JSON serialization for SHA-256 integrity hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return '{' + keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',') + '}';
}

export function computeBackupChecksum(data: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(data), 'utf8').digest('hex');
}

const FORBIDDEN_SECRET_KEYS = new Set([
  'password',
  'passwordHash',
  'sessionToken',
  'access_token',
  'refresh_token',
  'id_token',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'apiKey',
  'secret',
]);

function stripSensitiveFields<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripSensitiveFields) as unknown as T;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEYS.has(k) || k === 'userId') continue;
    clean[k] = stripSensitiveFields(v);
  }
  return clean as T;
}

/**
 * Creates a complete, integrity-checked backup bundle for a single novel.
 * Reads inside a transaction so all related tables reflect a consistent snapshot.
 */
export async function createNovelBackup(userId: string, novelId: string): Promise<NovelBackupBundle> {
  const db = getDb();
  const novelRow = db.prepare('SELECT * FROM novels WHERE id = ? AND userId = ?').get(novelId, userId) as any;
  if (!novelRow) throw new HttpError(404, 'Novel not found', 'novel_not_found');

  const snapshot = db.transaction(() => {
    const settings = db.prepare('SELECT * FROM novel_settings WHERE novelId = ?').get(novelId) as any;
    const premise = db.prepare('SELECT * FROM premises WHERE novelId = ?').get(novelId) as any;
    const storyBible = db.prepare('SELECT * FROM story_bibles WHERE novelId = ?').get(novelId) as any;
    const characters = db.prepare('SELECT * FROM characters WHERE novelId = ? ORDER BY createdAt ASC').all(novelId) as any[];
    const characterRelationships = db.prepare('SELECT * FROM character_relationships WHERE novelId = ?').all(novelId) as any[];
    const locations = db.prepare('SELECT * FROM locations WHERE novelId = ? ORDER BY createdAt ASC').all(novelId) as any[];
    const worldRules = db.prepare('SELECT * FROM world_rules WHERE novelId = ? ORDER BY createdAt ASC').all(novelId) as any[];
    const storyActs = db.prepare('SELECT * FROM story_acts WHERE novelId = ? ORDER BY orderIndex ASC').all(novelId) as any[];
    const chapterOutlines = db.prepare('SELECT * FROM chapter_outlines WHERE novelId = ? ORDER BY orderIndex ASC').all(novelId) as any[];
    const chapters = db.prepare('SELECT * FROM chapters WHERE novelId = ? ORDER BY chapterNumber ASC').all(novelId) as any[];
    const chapterIds = chapters.map(c => c.id);
    const chapterVersions = chapterIds.length
      ? (db.prepare(
          `SELECT * FROM chapter_versions WHERE chapterId IN (${chapterIds.map(() => '?').join(',')}) ORDER BY chapterId, versionNum ASC`,
        ).all(...chapterIds) as any[])
      : [];
    const timelineEvents = db.prepare('SELECT * FROM timeline_events WHERE novelId = ? ORDER BY orderIndex ASC').all(novelId) as any[];
    const plotThreads = db.prepare('SELECT * FROM plot_threads WHERE novelId = ? ORDER BY createdAt ASC').all(novelId) as any[];
    const chapterMemories = db.prepare('SELECT * FROM chapter_memories WHERE novelId = ? ORDER BY createdAt ASC').all(novelId) as any[];
    const consistencyIssues = db.prepare('SELECT * FROM consistency_issues WHERE novelId = ? ORDER BY createdAt ASC').all(novelId) as any[];
    const covers = db.prepare('SELECT * FROM image_assets WHERE novelId = ? AND userId = ? ORDER BY createdAt ASC').all(novelId, userId) as any[];

    return {
      novel: stripSensitiveFields(novelRow),
      settings: settings ? stripSensitiveFields(settings) : null,
      premise: premise ? stripSensitiveFields(premise) : null,
      storyBible: storyBible ? stripSensitiveFields(storyBible) : null,
      characters: stripSensitiveFields(characters),
      characterRelationships: stripSensitiveFields(characterRelationships),
      locations: stripSensitiveFields(locations),
      worldRules: stripSensitiveFields(worldRules),
      storyActs: stripSensitiveFields(storyActs),
      chapterOutlines: stripSensitiveFields(chapterOutlines),
      chapters: stripSensitiveFields(chapters),
      chapterVersions: stripSensitiveFields(chapterVersions),
      timelineEvents: stripSensitiveFields(timelineEvents),
      plotThreads: stripSensitiveFields(plotThreads),
      chapterMemories: stripSensitiveFields(chapterMemories),
      consistencyIssues: stripSensitiveFields(consistencyIssues),
      covers: stripSensitiveFields(covers),
    };
  })();

  // Attach file bytes (base64) for stored cover assets so restoring in a clean
  // environment also restores the associated files and keeps references valid.
  const coverAssets: Array<Record<string, any>> = [];
  for (const c of snapshot.covers) {
    let fileBase64: string | null = null;
    let contentType: string | null = null;
    if (c.storageKey) {
      const file = await readFile(c.storageKey).catch(() => null);
      if (file && file.data.length <= 5 * 1024 * 1024) {
        fileBase64 = file.data.toString('base64');
        contentType = file.contentType;
      }
    }
    coverAssets.push({ ...c, fileBase64, contentType });
  }

  const data: NovelBackupBundle['data'] = {
    novel: snapshot.novel,
    settings: snapshot.settings,
    premise: snapshot.premise,
    storyBible: snapshot.storyBible,
    characters: snapshot.characters,
    characterRelationships: snapshot.characterRelationships,
    locations: snapshot.locations,
    worldRules: snapshot.worldRules,
    storyActs: snapshot.storyActs,
    chapterOutlines: snapshot.chapterOutlines,
    chapters: snapshot.chapters,
    chapterVersions: snapshot.chapterVersions,
    timelineEvents: snapshot.timelineEvents,
    plotThreads: snapshot.plotThreads,
    chapterMemories: snapshot.chapterMemories,
    consistencyIssues: snapshot.consistencyIssues,
    coverAssets,
  };

  const checksum = computeBackupChecksum(data);
  const createdAt = new Date().toISOString();
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt,
    novelId: novelRow.id,
    novelTitle: novelRow.title,
    checksum,
    counts: {
      chapters: data.chapters.length,
      chapterVersions: data.chapterVersions.length,
      outlines: data.chapterOutlines.length,
      characters: data.characters.length,
      locations: data.locations.length,
      worldRules: data.worldRules.length,
      timelineEvents: data.timelineEvents.length,
      plotThreads: data.plotThreads.length,
      memories: data.chapterMemories.length,
      coverAssets: data.coverAssets.length,
    },
  };

  const bundle: NovelBackupBundle = { manifest, data };
  const byteSize = Buffer.byteLength(JSON.stringify(bundle), 'utf8');

  db.prepare(
    `INSERT INTO novel_backups (id, userId, novelId, formatVersion, checksum, byteSize, chapterCount, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(nanoid(), userId, novelId, BACKUP_FORMAT_VERSION, checksum, byteSize, data.chapters.length, createdAt);

  return bundle;
}

/**
 * Validates a backup bundle's schema, version compatibility, and SHA-256 checksum.
 */
export function validateBackupBundle(raw: unknown): NovelBackupBundle {
  if (!raw || typeof raw !== 'object') {
    throw new HttpError(400, 'Backup payload must be a JSON object.', 'invalid_backup_format');
  }
  const anyRaw = raw as any;
  if (anyRaw?.manifest?.format !== BACKUP_FORMAT) {
    throw new HttpError(400, 'Unrecognized backup format.', 'invalid_backup_format');
  }
  if (anyRaw?.manifest?.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new HttpError(
      400,
      `Unsupported backup format version (${anyRaw?.manifest?.formatVersion}). Expected version ${BACKUP_FORMAT_VERSION}.`,
      'incompatible_backup_version',
    );
  }

  const parsed = backupBundleSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    throw new HttpError(
      400,
      `Invalid backup structure: ${first ? `${first.path.join('.')}: ${first.message}` : 'validation failed'}`,
      'invalid_backup_schema',
    );
  }

  // Verify checksum integrity against the raw data payload before trusting it.
  const expectedChecksum = computeBackupChecksum(anyRaw.data);
  if (expectedChecksum !== parsed.data.manifest.checksum) {
    throw new HttpError(
      400,
      'Backup integrity check failed: checksum mismatch (the backup file may be corrupted or modified).',
      'invalid_backup_checksum',
    );
  }

  return parsed.data as unknown as NovelBackupBundle;
}

export interface RestoreNovelOptions {
  /**
   * When `targetNovelId` is provided, restores into that existing novel (which
   * must belong to `userId`). Otherwise creates a new novel (reusing the backup's
   * novelId if it does not collide in the database).
   */
  targetNovelId?: string;
}

/**
 * Restores a validated backup bundle transactionally.
 *
 * All validation and file writes happen BEFORE the database transaction begins;
 * if any step fails, existing database rows remain completely untouched.
 */
export async function restoreNovelBackup(
  userId: string,
  rawBundle: unknown,
  options: RestoreNovelOptions = {},
): Promise<{ novelId: string; title: string; chaptersRestored: number; versionsRestored: number }> {
  const bundle = validateBackupBundle(rawBundle);
  const { data } = bundle;
  const db = getDb();

  let targetNovelId: string;
  let replacingExisting = false;

  if (options.targetNovelId) {
    const owned = db.prepare('SELECT id FROM novels WHERE id = ? AND userId = ?').get(options.targetNovelId, userId) as any;
    if (!owned) throw new HttpError(404, 'Target novel not found', 'novel_not_found');
    targetNovelId = options.targetNovelId;
    replacingExisting = true;
  } else {
    const candidateId = data.novel.id || bundle.manifest.novelId;
    const collision = candidateId ? db.prepare('SELECT id FROM novels WHERE id = ?').get(candidateId) : true;
    targetNovelId = (!collision && candidateId) ? candidateId : nanoid();
  }

  // Restore embedded cover files into storage before opening the DB transaction.
  const restoredCoverFiles = new Map<string, { storageKey: string; url: string }>();
  for (const asset of data.coverAssets || []) {
    if (asset.fileBase64 && typeof asset.fileBase64 === 'string') {
      const ext = (asset.storageKey?.split('.').pop() || 'svg').toLowerCase();
      const safeExt = ['svg', 'png', 'jpg', 'jpeg'].includes(ext) ? ext : 'svg';
      const buf = Buffer.from(asset.fileBase64, 'base64');
      const stored = await saveFile({ data: buf, folder: 'covers', ext: safeExt });
      restoredCoverFiles.set(asset.id, { storageKey: stored.key, url: stored.url });
    }
  }

  const now = new Date().toISOString();

  // Map old entity IDs to new IDs so foreign-key relationships remain valid
  // even when restoring a backup alongside the original novel.
  const actIdMap = new Map<string, string>();
  const outlineIdMap = new Map<string, string>();
  const chapterIdMap = new Map<string, string>();
  const charIdMap = new Map<string, string>();
  const versionIdMap = new Map<string, string>();
  const coverIdMap = new Map<string, string>();

  const tx = db.transaction(() => {
    if (replacingExisting) {
      // Remove child rows of the target novel inside the transaction; if anything
      // below fails, SQLite rolls back the deletes automatically.
      db.prepare('DELETE FROM consistency_issues WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM chapter_memories WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM plot_threads WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM timeline_events WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM chapters WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM chapter_outlines WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM story_acts WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM character_relationships WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM characters WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM locations WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM world_rules WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM story_bibles WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM premises WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM novel_settings WHERE novelId = ?').run(targetNovelId);
      db.prepare('DELETE FROM image_assets WHERE novelId = ? AND userId = ?').run(targetNovelId, userId);

      db.prepare(
        `UPDATE novels SET title=?, premise=?, genre=?, tone=?, style=?, pov=?, audience=?,
                           targetWords=?, targetPages=?, targetChapters=?, writingMode=?,
                           status=?, stage=?, coverImageId=NULL, updatedAt=?, approvedAt=?, completedAt=?
          WHERE id=? AND userId=?`,
      ).run(
        data.novel.title,
        data.novel.premise ?? null,
        data.novel.genre || 'Fantasy',
        data.novel.tone ?? null,
        data.novel.style ?? null,
        data.novel.pov || 'Third Person Limited',
        data.novel.audience ?? null,
        data.novel.targetWords ?? 80000,
        data.novel.targetPages ?? 250,
        data.novel.targetChapters ?? 30,
        data.novel.writingMode || 'chapter',
        data.novel.status || 'draft',
        data.novel.stage || 'create',
        now,
        data.novel.approvedAt ?? null,
        data.novel.completedAt ?? null,
        targetNovelId,
        userId,
      );
    } else {
      db.prepare(
        `INSERT INTO novels (id,userId,title,premise,genre,tone,style,pov,audience,targetWords,targetPages,targetChapters,
                             writingMode,status,stage,coverImageId,createdAt,updatedAt,approvedAt,completedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)`,
      ).run(
        targetNovelId,
        userId,
        data.novel.title,
        data.novel.premise ?? null,
        data.novel.genre || 'Fantasy',
        data.novel.tone ?? null,
        data.novel.style ?? null,
        data.novel.pov || 'Third Person Limited',
        data.novel.audience ?? null,
        data.novel.targetWords ?? 80000,
        data.novel.targetPages ?? 250,
        data.novel.targetChapters ?? 30,
        data.novel.writingMode || 'chapter',
        data.novel.status || 'draft',
        data.novel.stage || 'create',
        data.novel.createdAt || now,
        now,
        data.novel.approvedAt ?? null,
        data.novel.completedAt ?? null,
      );
    }

    // Settings
    const s = data.settings || {};
    db.prepare(
      `INSERT INTO novel_settings (id,novelId,fontFamily,fontSize,lineSpacing,margin,pageSize,chapterHeadingStyle,
                                   pageNumbering,includeFrontMatter,includeToc,coverPlacement,wordsPerPage)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      nanoid(),
      targetNovelId,
      s.fontFamily || 'serif',
      s.fontSize ?? 12,
      s.lineSpacing ?? 1.6,
      s.margin ?? 72,
      s.pageSize || 'letter',
      s.chapterHeadingStyle || 'centered',
      s.pageNumbering || 'bottom-center',
      s.includeFrontMatter === 0 || s.includeFrontMatter === false ? 0 : 1,
      s.includeToc === 0 || s.includeToc === false ? 0 : 1,
      s.coverPlacement || 'front',
      s.wordsPerPage ?? 320,
    );

    // Covers
    for (const c of data.coverAssets || []) {
      const newCoverId = nanoid();
      if (c.id) coverIdMap.set(c.id, newCoverId);
      const fileInfo = (c.id && restoredCoverFiles.get(c.id)) || {
        storageKey: c.storageKey || `covers/${newCoverId}.svg`,
        url: c.url || `/api/files/covers/${newCoverId}.svg`,
      };
      db.prepare(
        `INSERT INTO image_assets (id,novelId,userId,kind,provider,storageKey,url,publicId,secureUrl,format,bytes,folder,width,height,prompt,isPrimary,meta,uploadedAt,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        newCoverId,
        targetNovelId,
        userId,
        c.kind || 'cover',
        c.provider || 'demo-svg',
        fileInfo.storageKey,
        c.secureUrl || fileInfo.url,
        c.publicId ?? null,
        c.secureUrl ?? null,
        c.format ?? null,
        c.bytes ?? null,
        c.folder ?? null,
        c.width ?? 768,
        c.height ?? 1024,
        c.prompt ?? null,
        c.isPrimary ? 1 : 0,
        c.meta ?? null,
        c.uploadedAt ?? null,
        c.createdAt || now,
        now,
      );
    }

    if (data.novel.coverImageId && coverIdMap.has(data.novel.coverImageId)) {
      db.prepare('UPDATE novels SET coverImageId = ? WHERE id = ?').run(
        coverIdMap.get(data.novel.coverImageId),
        targetNovelId,
      );
    }

    // Premise
    if (data.premise) {
      const p = data.premise;
      db.prepare(
        `INSERT INTO premises (id,novelId,logline,shortSynopsis,fullSynopsis,themes,setting,majorConflicts,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        nanoid(),
        targetNovelId,
        p.logline ?? null,
        p.shortSynopsis ?? null,
        p.fullSynopsis ?? null,
        typeof p.themes === 'string' ? p.themes : JSON.stringify(p.themes ?? []),
        p.setting ?? null,
        typeof p.majorConflicts === 'string' ? p.majorConflicts : JSON.stringify(p.majorConflicts ?? []),
        p.createdAt || now,
        now,
      );
    }

    // Story Bible
    if (data.storyBible) {
      const sb = data.storyBible;
      db.prepare(
        `INSERT INTO story_bibles (id,novelId,overview,toneNotes,styleGuide,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(nanoid(), targetNovelId, sb.overview ?? null, sb.toneNotes ?? null, sb.styleGuide ?? null, sb.createdAt || now, now);
    }

    // Characters
    for (const ch of data.characters || []) {
      const newCharId = nanoid();
      if (ch.id) charIdMap.set(ch.id, newCharId);
      db.prepare(
        `INSERT INTO characters (id,novelId,name,role,age,appearance,personality,motivation,goals,fears,arc,backstory,avatarId,meta,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        newCharId,
        targetNovelId,
        ch.name || 'Character',
        ch.role || 'supporting',
        ch.age ?? null,
        ch.appearance ?? null,
        ch.personality ?? null,
        ch.motivation ?? null,
        ch.goals ?? null,
        ch.fears ?? null,
        ch.arc ?? null,
        ch.backstory ?? null,
        ch.avatarId ?? null,
        ch.meta ?? null,
        ch.createdAt || now,
        now,
      );
    }

    // Character Relationships
    for (const rel of data.characterRelationships || []) {
      const fromId = charIdMap.get(rel.fromId);
      const toId = charIdMap.get(rel.toId);
      if (fromId && toId) {
        db.prepare(
          `INSERT INTO character_relationships (id,novelId,fromId,toId,relation,description)
           VALUES (?,?,?,?,?,?)`,
        ).run(nanoid(), targetNovelId, fromId, toId, rel.relation || 'related', rel.description ?? null);
      }
    }

    // Locations
    for (const loc of data.locations || []) {
      db.prepare(
        `INSERT INTO locations (id,novelId,name,description,kind,imageId,meta,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(nanoid(), targetNovelId, loc.name || 'Location', loc.description ?? null, loc.kind ?? null, null, loc.meta ?? null, loc.createdAt || now, now);
    }

    // World Rules
    for (const r of data.worldRules || []) {
      db.prepare(
        `INSERT INTO world_rules (id,novelId,name,description,category,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(nanoid(), targetNovelId, r.name || 'Rule', r.description || '', r.category ?? 'world', r.createdAt || now, now);
    }

    // Story Acts
    for (const act of data.storyActs || []) {
      const newActId = nanoid();
      if (act.id) actIdMap.set(act.id, newActId);
      db.prepare(
        `INSERT INTO story_acts (id,novelId,actNumber,name,description,purpose,turningPoint,orderIndex)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(newActId, targetNovelId, act.actNumber ?? 1, act.name || 'Act', act.description ?? null, act.purpose ?? null, act.turningPoint ?? null, act.orderIndex ?? 1);
    }

    // Chapter Outlines
    for (const o of data.chapterOutlines || []) {
      const newOutlineId = nanoid();
      if (o.id) outlineIdMap.set(o.id, newOutlineId);
      const mappedActId = o.actId ? (actIdMap.get(o.actId) ?? null) : null;
      db.prepare(
        `INSERT INTO chapter_outlines (id,novelId,actId,chapterNumber,title,summary,narrativePurpose,majorEvents,
                                       charactersInvolved,location,conflict,emotionalObjective,plotAdvancement,foreshadowing,
                                       targetWords,estimatedPages,status,orderIndex)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        newOutlineId,
        targetNovelId,
        mappedActId,
        o.chapterNumber,
        o.title || `Chapter ${o.chapterNumber}`,
        o.summary ?? null,
        o.narrativePurpose ?? null,
        o.majorEvents ?? '[]',
        o.charactersInvolved ?? '[]',
        o.location ?? null,
        o.conflict ?? null,
        o.emotionalObjective ?? null,
        o.plotAdvancement ?? null,
        o.foreshadowing ?? null,
        o.targetWords ?? 2500,
        o.estimatedPages ?? 8,
        o.status || 'planned',
        o.orderIndex ?? (o.chapterNumber - 1),
      );
    }

    // Chapters
    for (const ch of data.chapters || []) {
      const newChapterId = nanoid();
      if (ch.id) chapterIdMap.set(ch.id, newChapterId);
      const mappedOutlineId = ch.outlineId ? (outlineIdMap.get(ch.outlineId) ?? null) : null;
      db.prepare(
        `INSERT INTO chapters (id,novelId,outlineId,chapterNumber,title,contentJson,generatedContentJson,contentHtml,plainText,
                               status,wordCount,pageCountEst,summary,importantEvents,currentVersionId,revision,
                               generationSource,generatedAt,createdAt,updatedAt,approvedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)`,
      ).run(
        newChapterId,
        targetNovelId,
        mappedOutlineId,
        ch.chapterNumber,
        ch.title,
        ch.contentJson,
        ch.generatedContentJson ?? ch.contentJson,
        ch.contentHtml ?? null,
        ch.plainText ?? null,
        ch.status || 'draft',
        ch.wordCount ?? 0,
        ch.pageCountEst ?? 1,
        ch.summary ?? null,
        ch.importantEvents ?? null,
        ch.revision ?? 1,
        ch.generationSource ?? null,
        ch.generatedAt ?? null,
        ch.createdAt || now,
        now,
        ch.approvedAt ?? null,
      );
    }

    // Chapter Versions
    for (const v of data.chapterVersions || []) {
      const mappedChapterId = chapterIdMap.get(v.chapterId);
      if (!mappedChapterId) continue;
      const newVersionId = nanoid();
      if (v.id) versionIdMap.set(v.id, newVersionId);
      db.prepare(
        `INSERT INTO chapter_versions (id,novelId,chapterId,versionNum,contentJson,wordCount,note,revisionType,parentVersionId,createdAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        newVersionId,
        targetNovelId,
        mappedChapterId,
        v.versionNum ?? 1,
        v.contentJson || '{"type":"doc","content":[]}',
        v.wordCount ?? 0,
        v.note ?? null,
        v.revisionType || 'snapshot',
        v.parentVersionId ? (versionIdMap.get(v.parentVersionId) ?? null) : null,
        v.createdAt || now,
      );
    }

    // Link currentVersionId on restored chapters
    for (const ch of data.chapters || []) {
      if (ch.id && ch.currentVersionId) {
        const mappedChId = chapterIdMap.get(ch.id);
        const mappedVerId = versionIdMap.get(ch.currentVersionId);
        if (mappedChId && mappedVerId) {
          db.prepare('UPDATE chapters SET currentVersionId = ? WHERE id = ?').run(mappedVerId, mappedChId);
        }
      }
    }

    // Timeline Events
    for (const e of data.timelineEvents || []) {
      const mappedChId = e.chapterId ? (chapterIdMap.get(e.chapterId) ?? null) : null;
      db.prepare(
        `INSERT INTO timeline_events (id,novelId,chapterId,label,description,"when",orderIndex,createdAt)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(nanoid(), targetNovelId, mappedChId, e.label || 'Event', e.description || '', e.when ?? null, e.orderIndex ?? 0, e.createdAt || now);
    }

    // Plot Threads
    for (const t of data.plotThreads || []) {
      const introCh = t.introducedInChapterId ? (chapterIdMap.get(t.introducedInChapterId) ?? null) : null;
      const resCh = t.resolvedInChapterId ? (chapterIdMap.get(t.resolvedInChapterId) ?? null) : null;
      db.prepare(
        `INSERT INTO plot_threads (id,novelId,title,description,status,introducedInChapterId,resolvedInChapterId,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(nanoid(), targetNovelId, t.title || 'Thread', t.description || '', t.status || 'open', introCh, resCh, t.createdAt || now, now);
    }

    // Chapter Memories
    for (const m of data.chapterMemories || []) {
      const mappedChId = m.chapterId ? (chapterIdMap.get(m.chapterId) ?? null) : null;
      const mappedCharId = m.characterId ? (charIdMap.get(m.characterId) ?? null) : null;
      db.prepare(
        `INSERT INTO chapter_memories (id,novelId,chapterId,characterId,kind,content,importance,embedding,meta,createdAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(nanoid(), targetNovelId, mappedChId, mappedCharId, m.kind || 'summary', m.content || '', m.importance ?? 1, m.embedding ?? null, m.meta ?? null, m.createdAt || now);
    }

    // Consistency Issues
    for (const i of data.consistencyIssues || []) {
      const mappedChId = i.chapterId ? (chapterIdMap.get(i.chapterId) ?? null) : null;
      db.prepare(
        `INSERT INTO consistency_issues (id,novelId,chapterId,kind,severity,title,description,evidence,suggestion,status,meta,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(nanoid(), targetNovelId, mappedChId, i.kind || 'timeline', i.severity || 'info', i.title || 'Issue', i.description || '', i.evidence ?? null, i.suggestion ?? null, i.status || 'open', i.meta ?? null, i.createdAt || now, now);
    }
  });
  tx();

  return {
    novelId: targetNovelId,
    title: data.novel.title,
    chaptersRestored: data.chapters.length,
    versionsRestored: data.chapterVersions.length,
  };
}

/**
 * Performs an online, consistent SQLite database backup using SQLite's native
 * backup API (`better-sqlite3`'s `db.backup(destinationPath)`) instead of
 * unsafely copying a live database file.
 */
export async function backupSqliteDatabaseFile(destinationPath: string): Promise<{ path: string; completedAt: string }> {
  const db = getDb();
  await db.backup(destinationPath);
  return { path: destinationPath, completedAt: new Date().toISOString() };
}

export function listNovelBackups(novelId: string) {
  const db = getDb();
  return db.prepare('SELECT * FROM novel_backups WHERE novelId = ? ORDER BY createdAt DESC LIMIT 20').all(novelId) as any[];
}
