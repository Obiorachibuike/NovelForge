import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import { wordsToPages } from '@/lib/utils/cn';
import type { CreateNovelInput, NovelRow, NovelSettingsInput, NovelSettingsRow } from '@/types';
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

export async function listNovels(userId: string): Promise<NovelWithProgress[]> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT n.*, img.url AS coverUrl,
      COALESCE((SELECT SUM(c.wordCount) FROM chapters c WHERE c.novelId = n.id AND c.status = 'approved'), 0) AS wordsWritten,
      COALESCE((SELECT COUNT(*) FROM chapters c WHERE c.novelId = n.id AND c.status = 'approved'), 0) AS chaptersCompleted,
      COALESCE((SELECT COUNT(*) FROM chapter_outlines o WHERE o.novelId = n.id), 0) AS chaptersTotal
    FROM novels n
    LEFT JOIN image_assets img ON img.id = n.coverImageId
    WHERE n.userId = ?
    ORDER BY n.updatedAt DESC
  `).all(userId) as any[];
  return rows.map(r => ({
    ...r,
    pagesEst: wordsToPages(r.wordsWritten, 320),
    percentComplete: Math.round((r.wordsWritten / Math.max(1, r.targetWords)) * 100),
  }));
}

export async function getNovel(novelId: string, userId: string): Promise<NovelWithProgress | null> {
  const db = getDb();
  const row = db.prepare(`
    SELECT n.*, img.url AS coverUrl,
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

export async function updateNovelStage(novelId: string, userId: string, stage: string, extra: Partial<NovelRow> = {}) {
  const db = getDb();
  db.prepare(`UPDATE novels SET stage = ?, updatedAt = ? WHERE id = ? AND userId = ?`)
    .run(stage, new Date().toISOString(), novelId, userId);
  if (Object.keys(extra).length) {
    const sets: string[] = []; const vals: any[] = [];
    for (const [k,v] of Object.entries(extra)) { sets.push(`${k} = ?`); vals.push(v); }
    vals.push(new Date().toISOString(), novelId, userId);
    db.prepare(`UPDATE novels SET ${sets.join(', ')}, updatedAt = ? WHERE id = ? AND userId = ?`).run(...vals);
  }
}

export async function updateNovelSettings(novelId: string, userId: string, patch: Partial<NovelSettingsInput>) {
  const db = getDb();
  const sets: string[] = []; const vals: any[] = [];
  for (const [k,v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return getSettings(novelId);
  vals.push(novelId, userId);
  db.prepare(
    `UPDATE novel_settings SET ${sets.join(',')} WHERE novelId = ? AND EXISTS(SELECT 1 FROM novels WHERE id=? AND userId=?)`
  ).run(...vals, novelId);
  return getSettings(novelId);
}

export function getSettings(novelId: string): NovelSettingsRow | null {
  const db = getDb();
  return db.prepare('SELECT * FROM novel_settings WHERE novelId = ?').get(novelId) as any;
}

export async function setCover(novelId: string, userId: string, imageId: string) {
  const db = getDb();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE image_assets SET isPrimary = 0 WHERE novelId = ?`).run(novelId);
    db.prepare(`UPDATE image_assets SET isPrimary = 1 WHERE id = ? AND novelId = ? AND userId = ?`)
      .run(imageId, novelId, userId);
    db.prepare(`UPDATE novels SET coverImageId = ?, stage = CASE WHEN stage='cover' THEN 'prepare' ELSE stage END, updatedAt = ? WHERE id=? AND userId=?`)
      .run(imageId, now, novelId, userId);
  });
  tx();
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
