import fs from 'node:fs';
import { nanoid } from 'nanoid';
import type { Database } from 'better-sqlite3';
import { getDb, resetDbForTests, resolveSqlitePath } from '@/lib/db';

/** Closes the cached handle, deletes the database file and re-opens a clean one. */
export function freshDatabase(): Database {
  resetDbForTests();
  const file = resolveSqlitePath();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(file + suffix); } catch { /* not present */ }
  }
  return getDb();
}

export function db(): Database {
  return getDb();
}

export interface TestUser { id: string; email: string; name: string }

export function seedUser(partial: Partial<TestUser> = {}): TestUser {
  const database = getDb();
  const now = new Date().toISOString();
  const user: TestUser = {
    id: partial.id || `user_${nanoid(8)}`,
    email: partial.email || `writer_${nanoid(6)}@example.com`,
    name: partial.name || 'Test Writer',
  };
  database.prepare(
    'INSERT INTO users (id,name,email,passwordHash,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)',
  ).run(user.id, user.name, user.email, null, null, now, now);
  return user;
}

export interface TestNovel { id: string; userId: string }

export function seedNovel(userId: string, overrides: Record<string, unknown> = {}): TestNovel {
  const database = getDb();
  const now = new Date().toISOString();
  const id = (overrides.id as string) || `novel_${nanoid(8)}`;
  database.prepare(
    `INSERT INTO novels (id,userId,title,premise,genre,tone,style,pov,audience,targetWords,targetPages,targetChapters,
                         writingMode,status,stage,coverImageId,createdAt,updatedAt,approvedAt,completedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, userId, (overrides.title as string) || 'The Test Kingdom', overrides.premise ?? null,
    (overrides.genre as string) || 'Fantasy', overrides.tone ?? null, overrides.style ?? null,
    (overrides.pov as string) || 'Third Person Limited', overrides.audience ?? null,
    overrides.targetWords ?? 80000, overrides.targetPages ?? 250, overrides.targetChapters ?? 3,
    (overrides.writingMode as string) || 'chapter', (overrides.status as string) || 'draft',
    (overrides.stage as string) || 'writing', overrides.coverImageId ?? null, now, now, null, null,
  );
  database.prepare(
    `INSERT INTO novel_settings (id,novelId,fontFamily,fontSize,lineSpacing,margin,pageSize,chapterHeadingStyle,
                                 pageNumbering,includeFrontMatter,includeToc,coverPlacement,wordsPerPage)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(nanoid(), id, 'serif', 12, 1.6, 72, 'letter', 'centered', 'bottom-center', 1, 1, 'front', 320);
  return { id, userId };
}

export function seedOutline(novelId: string, chapters: number): void {
  const database = getDb();
  const insert = database.prepare(
    `INSERT INTO chapter_outlines (id,novelId,actId,chapterNumber,title,summary,narrativePurpose,majorEvents,
                                   charactersInvolved,location,conflict,emotionalObjective,plotAdvancement,foreshadowing,
                                   targetWords,estimatedPages,status,orderIndex)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let n = 1; n <= chapters; n++) {
    insert.run(
      nanoid(), novelId, null, n, `Chapter ${n}`, `Summary ${n}`, 'Advance the plot',
      JSON.stringify([`Event ${n}`]), JSON.stringify(['Kael', 'Seren']), 'The Glass City',
      'Loyalty vs truth', 'resolve', 'Central mystery deepens', 'A hint of what comes next',
      2000, 7, 'planned', n - 1,
    );
  }
}

export function seedChapter(novelId: string, overrides: Record<string, unknown> = {}): string {
  const database = getDb();
  const now = new Date().toISOString();
  const id = (overrides.id as string) || `chapter_${nanoid(8)}`;
  const chapterNumber = (overrides.chapterNumber as number) || 1;
  const plainText = (overrides.plainText as string) ?? 'The rain had stopped by the time she reached the bridge.';
  const wordCount = plainText.trim() ? plainText.trim().split(/\s+/).length : 0;
  const outlineId = (overrides.outlineId as string) || (database.prepare('SELECT id FROM chapter_outlines WHERE novelId=? AND chapterNumber=?').get(novelId, chapterNumber) as any)?.id || null;
  database.prepare(
    `INSERT INTO chapters (id,novelId,outlineId,chapterNumber,title,contentJson,contentHtml,plainText,status,
                           wordCount,pageCountEst,summary,importantEvents,currentVersionId,createdAt,updatedAt,approvedAt,generationSource,generatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, novelId, outlineId, chapterNumber, (overrides.title as string) || `Chapter ${chapterNumber}`,
    JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: plainText }] }] }),
    `<p>${plainText}</p>`, plainText, (overrides.status as string) || 'generated', wordCount,
    Math.max(1, Math.round(wordCount / 320)), overrides.summary ?? null, overrides.importantEvents ?? null,
    null, now, now, overrides.status === 'approved' ? now : null,
    (overrides.generationSource as string) || 'openai', now,
  );
  return id;
}

export function seedCover(userId: string, novelId: string, overrides: Record<string, unknown> = {}): string {
  const database = getDb();
  const id = (overrides.id as string) || `img_${nanoid(8)}`;
  const key = (overrides.storageKey as string) || `covers/${nanoid(8)}.svg`;
  database.prepare(
    `INSERT INTO image_assets (id,novelId,userId,kind,provider,storageKey,url,width,height,prompt,isPrimary,meta,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, novelId, userId, 'cover', 'demo-svg', key, `/api/files/${key}`, 768, 1024, 'prompt',
    overrides.isPrimary ?? 0, null, new Date().toISOString());
  return id;
}

export function seedExportRow(userId: string, novelId: string, overrides: Record<string, unknown> = {}): string {
  const database = getDb();
  const id = (overrides.id as string) || `export_${nanoid(8)}`;
  const key = (overrides.fileKey as string) || `exports/${nanoid(8)}.txt`;
  database.prepare(
    `INSERT INTO exports (id,userId,novelId,format,status,fileKey,fileUrl,fileSize,options,completedAt,createdAt,mimeType)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, userId, novelId, 'txt', 'completed', key, `/api/files/${key}`, 128, '{}',
    new Date().toISOString(), new Date().toISOString(), 'text/plain');
  return id;
}

/** Builds a JSON Request for route handlers under test. */
export function jsonRequest(url: string, body?: unknown, init: RequestInit = {}): Request {
  return new Request(`http://localhost:3000${url}`, {
    method: init.method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });
}

/** Extracts the JSON payload from a Response. */
export async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Simulates a process restart: closes the cached handle and reopens the same
 * database file. Used to prove that data written before a restart is still
 * readable afterwards (covers, chapters, settings, jobs, exports).
 */
export function reopenDatabase(): Database {
  resetDbForTests();
  return getDb();
}
