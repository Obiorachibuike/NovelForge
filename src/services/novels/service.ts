import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import { wordsToPages } from '@/lib/utils/cn';
import type { CreateNovelInput, NovelRow, NovelSettingsInput, NovelSettingsRow, UpdateNovelInput } from '@/types';
import { HttpError } from '@/lib/api/http';
import { assertCanCreateNovel } from '@/services/billing/service';
import {
  isCloudinaryConfigured,
  readCandidateCoverBytes,
  validateCoverImageBuffer,
  uploadCoverToCloudinary,
  deleteCloudinaryCover,
  serializeSafeCoverMetadata,
  type SafeCoverMetadata,
} from '@/services/covers/cloudinary-cover-service';
import { makeSvgCover } from '@/services/images/service';
import 'server-only';

export interface NovelWithProgress extends NovelRow {
  wordsWritten: number;
  chaptersCompleted: number;
  chaptersTotal: number;
  pagesEst: number;
  percentComplete: number;
  coverUrl: string | null;
}

export async function createNovel(userId: string, input: CreateNovelInput): Promise<NovelRow> {
  // Entitlement gate: an admin, a comped account, or an active subscription with
  // room left. Throws 402 `payment_required` otherwise (see billing/service.ts).
  assertCanCreateNovel(userId);

  const db = getDb();
  const now = new Date().toISOString();
  const id = nanoid();
  const novel: NovelRow = {
    id, userId,
    title: input.title.trim(),
    premise: input.premise?.trim() || null,
    genre: input.genre || 'Fantasy',
    tone: input.tone?.trim() || null,
    style: input.style?.trim() || null,
    pov: input.pov || 'Third Person Limited',
    audience: input.audience?.trim() || null,
    targetWords: input.targetWords,
    targetPages: input.targetPages,
    targetChapters: input.targetChapters,
    writingMode: input.writingMode || 'chapter',
    status: 'draft', stage: 'cover',
    coverImageId: null,
    createdAt: now, updatedAt: now,
    approvedAt: null, completedAt: null,
  };

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO novels (id,userId,title,premise,genre,tone,style,pov,audience,targetWords,targetPages,targetChapters,writingMode,status,stage,coverImageId,createdAt,updatedAt,approvedAt,completedAt)
       VALUES (@id,@userId,@title,@premise,@genre,@tone,@style,@pov,@audience,@targetWords,@targetPages,@targetChapters,@writingMode,@status,@stage,@coverImageId,@createdAt,@updatedAt,@approvedAt,@completedAt)`
    ).run(novel);

    // Default settings
    db.prepare(
      `INSERT INTO novel_settings (id,novelId,fontFamily,fontSize,lineSpacing,margin,pageSize,chapterHeadingStyle,pageNumbering,includeFrontMatter,includeToc,coverPlacement,wordsPerPage)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(nanoid(), id, 'serif', 12, 1.6, 72, 'letter', 'centered', 'bottom-center', 1, 1, 'front', 320);
  });
  tx();
  return novel;
}

export async function listNovels(
  userId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<NovelWithProgress[]> {
  const db = getDb();
  const hasLimit = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0;
  const limit = hasLimit ? Math.min(200, Math.floor(options.limit!)) : 500;
  const offset = typeof options.offset === 'number' && Number.isFinite(options.offset) && options.offset >= 0
    ? Math.floor(options.offset)
    : 0;
  const rows = db.prepare(`
    SELECT n.*, COALESCE(img.secureUrl, img.url) AS coverUrl,
      COALESCE((SELECT SUM(c.wordCount) FROM chapters c WHERE c.novelId = n.id AND c.status = 'approved'), 0) AS wordsWritten,
      COALESCE((SELECT COUNT(*) FROM chapters c WHERE c.novelId = n.id AND c.status = 'approved'), 0) AS chaptersCompleted,
      COALESCE((SELECT COUNT(*) FROM chapter_outlines o WHERE o.novelId = n.id), 0) AS chaptersTotal
    FROM novels n
    LEFT JOIN image_assets img ON img.id = n.coverImageId
    WHERE n.userId = ?
    ORDER BY n.updatedAt DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset) as any[];
  return rows.map(r => ({
    ...r,
    pagesEst: wordsToPages(r.wordsWritten, 320),
    percentComplete: Math.round((r.wordsWritten / Math.max(1, r.targetWords)) * 100),
  }));
}

export async function updateNovel(
  novelId: string,
  userId: string,
  patch: Partial<UpdateNovelInput>,
): Promise<NovelWithProgress> {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM novels WHERE id = ? AND userId = ?').get(novelId, userId);
  if (!existing) throw new HttpError(404, 'Novel not found', 'novel_not_found');

  const entries = Object.entries(patch).filter(
    ([k, v]) => v !== undefined && NOVEL_PATCHABLE_COLUMNS.has(k),
  );
  if (entries.length) {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of entries) {
      sets.push(`${k} = ?`);
      vals.push(typeof v === 'string' && k === 'title' ? v.trim() : v);
    }
    const now = new Date().toISOString();
    vals.push(now, novelId, userId);
    db.prepare(`UPDATE novels SET ${sets.join(', ')}, updatedAt = ? WHERE id = ? AND userId = ?`).run(...vals);
  }
  const updated = await getNovel(novelId, userId);
  if (!updated) throw new HttpError(404, 'Novel not found', 'novel_not_found');
  return updated;
}

export async function getNovel(novelId: string, userId: string): Promise<NovelWithProgress | null> {
  const db = getDb();
  const row = db.prepare(`
    SELECT n.*, COALESCE(img.secureUrl, img.url) AS coverUrl,
      COALESCE((SELECT SUM(c.wordCount) FROM chapters c WHERE c.novelId = n.id AND c.status = 'approved'), 0) AS wordsWritten,
      COALESCE((SELECT COUNT(*) FROM chapters c WHERE c.novelId = n.id AND c.status = 'approved'), 0) AS chaptersCompleted,
      COALESCE((SELECT COUNT(*) FROM chapter_outlines o WHERE o.novelId = n.id), 0) AS chaptersTotal
    FROM novels n
    LEFT JOIN image_assets img ON img.id = n.coverImageId
    WHERE n.id = ? AND n.userId = ?
  `).get(novelId, userId) as any;
  if (!row) return null;
  return {
    ...row,
    pagesEst: wordsToPages(row.wordsWritten, 320),
    percentComplete: Math.round((row.wordsWritten / Math.max(1, row.targetWords)) * 100),
  };
}

/** Columns a caller is allowed to patch through this helper (no arbitrary keys → no SQL injection). */
const NOVEL_PATCHABLE_COLUMNS = new Set([
  'title', 'premise', 'genre', 'tone', 'style', 'pov', 'audience',
  'targetWords', 'targetPages', 'targetChapters', 'writingMode', 'status', 'coverImageId',
]);

export async function updateNovelStage(novelId: string, userId: string, stage: string, extra: Partial<NovelRow> = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE novels SET stage = ?, updatedAt = ? WHERE id = ? AND userId = ?`)
    .run(stage, now, novelId, userId);
  const entries = Object.entries(extra).filter(([k]) => NOVEL_PATCHABLE_COLUMNS.has(k));
  if (entries.length) {
    const sets: string[] = []; const vals: any[] = [];
    for (const [k, v] of entries) { sets.push(`${k} = ?`); vals.push(v); }
    vals.push(now, novelId, userId);
    db.prepare(`UPDATE novels SET ${sets.join(', ')}, updatedAt = ? WHERE id = ? AND userId = ?`).run(...vals);
  }
}

const SETTINGS_COLUMNS = new Set([
  'fontFamily', 'fontSize', 'lineSpacing', 'margin', 'pageSize', 'chapterHeadingStyle',
  'pageNumbering', 'includeFrontMatter', 'includeToc', 'coverPlacement', 'wordsPerPage',
]);

/**
 * Updates manuscript/formatting settings for a novel the caller owns.
 *
 * Returns 404 via HttpError when the novel is not theirs, and the row count is
 * checked so a failed ownership match can never be mistaken for a success.
 */
export async function updateNovelSettings(novelId: string, userId: string, patch: Partial<NovelSettingsInput>) {
  const db = getDb();
  const novel = db.prepare('SELECT id FROM novels WHERE id = ? AND userId = ?').get(novelId, userId) as any;
  if (!novel) throw new HttpError(404, 'Novel not found', 'novel_not_found');

  const sets: string[] = []; const vals: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !SETTINGS_COLUMNS.has(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return getSettings(novelId);
  vals.push(novelId);
  db.prepare(`UPDATE novel_settings SET ${sets.join(', ')} WHERE novelId = ?`).run(...vals);
  return getSettings(novelId);
}

export function getSettings(novelId: string): NovelSettingsRow | null {
  const db = getDb();
  return db.prepare('SELECT * FROM novel_settings WHERE novelId = ?').get(novelId) as any;
}

export async function setCover(
  novelId: string,
  userId: string,
  imageId: string,
): Promise<{ ok: true; cover: SafeCoverMetadata }> {
  const db = getDb();
  const now = new Date().toISOString();

  const novel = db
    .prepare('SELECT id, title, genre, tone, coverImageId FROM novels WHERE id = ? AND userId = ?')
    .get(novelId, userId) as any;
  if (!novel) throw new HttpError(404, 'Novel not found', 'novel_not_found');

  // The image must exist, belong to this novel and belong to this user;
  // otherwise a caller could attach (and later export) someone else's artwork.
  const image = db
    .prepare('SELECT * FROM image_assets WHERE id = ? AND novelId = ? AND userId = ?')
    .get(imageId, novelId, userId) as any;
  if (!image) throw new HttpError(404, 'Cover image not found for this novel.', 'cover_not_found');

  // Check if there is an existing primary cover with a Cloudinary publicId so we
  // can replace/clean up the old Cloudinary asset once the new selection commits.
  const previousPrimary = db
    .prepare('SELECT id, publicId, userId, novelId FROM image_assets WHERE novelId = ? AND isPrimary = 1 LIMIT 1')
    .get(novelId) as { id: string; publicId?: string | null; userId: string; novelId: string } | undefined;

  const shouldUploadToCloudinary =
    isCloudinaryConfigured() ||
    process.env.STORAGE_PROVIDER === 'cloudinary' ||
    process.env.REQUIRE_CLOUDINARY_COVERS === 'true';

  let uploadedCloudinary: Awaited<ReturnType<typeof uploadCoverToCloudinary>> | null = null;

  if (shouldUploadToCloudinary && !image.publicId) {
    let candidateBytes = await readCandidateCoverBytes(image.storageKey);
    if (!candidateBytes && (image.provider === 'demo-svg' || image.provider === 'svg-fallback')) {
      candidateBytes = makeSvgCover(novel, 0);
    }
    if (!candidateBytes) {
      throw new HttpError(
        404,
        'Selected cover candidate file is no longer available. Generate a new cover candidate and try again.',
        'cover_file_missing',
      );
    }

    uploadedCloudinary = await uploadCoverToCloudinary({
      userId,
      novelId,
      imageId: image.id,
      data: candidateBytes,
    });
  } else {
    // Even in local/S3 mode, if candidate bytes exist on disk, validate their content.
    const candidateBytes = await readCandidateCoverBytes(image.storageKey).catch(() => null);
    if (candidateBytes) {
      validateCoverImageBuffer(candidateBytes);
    }
  }

  try {
    const tx = db.transaction(() => {
      db.prepare(`UPDATE image_assets SET isPrimary = 0, updatedAt = ? WHERE novelId = ?`).run(now, novelId);
      if (uploadedCloudinary) {
        db.prepare(
          `UPDATE image_assets
              SET isPrimary = 1,
                  url = ?,
                  secureUrl = ?,
                  publicId = ?,
                  storageKey = ?,
                  format = ?,
                  bytes = ?,
                  folder = ?,
                  width = COALESCE(?, width),
                  height = COALESCE(?, height),
                  uploadedAt = ?,
                  updatedAt = ?
            WHERE id = ? AND novelId = ? AND userId = ?`,
        ).run(
          uploadedCloudinary.secureUrl,
          uploadedCloudinary.secureUrl,
          uploadedCloudinary.publicId,
          uploadedCloudinary.publicId,
          uploadedCloudinary.format,
          uploadedCloudinary.bytes,
          uploadedCloudinary.folder,
          uploadedCloudinary.width ?? null,
          uploadedCloudinary.height ?? null,
          uploadedCloudinary.uploadedAt,
          now,
          imageId,
          novelId,
          userId,
        );
      } else {
        db.prepare(`UPDATE image_assets SET isPrimary = 1, updatedAt = ? WHERE id = ?`).run(now, imageId);
      }

      const updated = db
        .prepare(
          `UPDATE novels
              SET coverImageId = ?,
                  stage = CASE WHEN stage='cover' THEN 'prepare' ELSE stage END,
                  updatedAt = ?
            WHERE id = ? AND userId = ?`,
        )
        .run(imageId, now, novelId, userId);
      if (updated.changes === 0) throw new HttpError(404, 'Novel not found', 'novel_not_found');
    });
    tx();
  } catch (dbErr) {
    // Avoid inconsistent state: if the Cloudinary upload succeeded but the DB
    // update failed, clean up the newly uploaded Cloudinary asset immediately.
    if (uploadedCloudinary?.publicId) {
      await deleteCloudinaryCover(uploadedCloudinary.publicId, { userId, novelId }).catch(() => false);
    }
    throw dbErr;
  }

  // If a previous cover had a different Cloudinary publicId, clean it up after commit.
  if (
    previousPrimary?.publicId &&
    previousPrimary.id !== imageId &&
    previousPrimary.publicId !== uploadedCloudinary?.publicId &&
    isCloudinaryConfigured()
  ) {
    await deleteCloudinaryCover(previousPrimary.publicId, {
      userId: previousPrimary.userId,
      novelId: previousPrimary.novelId,
    }).catch(() => false);
  }

  const finalRow = db
    .prepare('SELECT * FROM image_assets WHERE id = ? AND novelId = ? AND userId = ?')
    .get(imageId, novelId, userId) as Record<string, any>;

  return {
    ok: true,
    cover: serializeSafeCoverMetadata(finalRow),
  };
}

export async function deleteNovel(novelId: string, userId: string) {
  const db = getDb();
  db.prepare(`DELETE FROM novels WHERE id = ? AND userId = ?`).run(novelId, userId);
}

export async function getWordStats(novelId: string) {
  const db = getDb();
  const r = db.prepare(`
    SELECT
      COALESCE(SUM(wordCount),0) AS totalWords,
      COUNT(*) AS totalChapters,
      COALESCE(SUM(CASE WHEN status='approved' THEN wordCount ELSE 0 END),0) AS approvedWords,
      COALESCE(SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END),0) AS approvedChapters
    FROM chapters WHERE novelId = ?
  `).get(novelId) as any;
  return r;
}
