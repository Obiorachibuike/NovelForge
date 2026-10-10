import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import 'server-only';

let _db: Database.Database | null = null;

/**
 * Connects to the SQLite database (default: prisma/dev.db) and runs the
 * schema initializer. In production this module can be swapped for a
 * PostgreSQL-backed adapter without changes to service modules (they only
 * consume the exported `db` handle and use parameterised SQL).
 */
export function getDb(): Database.Database {
  if (_db) return _db;

  const url = process.env.DATABASE_URL || 'file:./prisma/dev.db';
  const filePath = url.startsWith('file:') ? url.slice(5) : url;
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath.replace(/^\.\//, ''));

  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  const db = new Database(absPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  _db = db;
  return db;
}

/**
 * Creates tables if they don't yet exist. We use CREATE TABLE IF NOT EXISTS so
 * the schema is self-initialising on first run.
 */
function migrate(db: Database.Database) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, emailVerified TEXT,
    image TEXT, passwordHash TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL,
    provider TEXT NOT NULL, providerAccountId TEXT NOT NULL,
    refresh_token TEXT, access_token TEXT, expires_at INTEGER,
    token_type TEXT, scope TEXT, id_token TEXT, session_state TEXT,
    UNIQUE(provider, providerAccountId),
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, sessionToken TEXT UNIQUE NOT NULL,
    userId TEXT NOT NULL, expires TEXT NOT NULL,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS verification_tokens (
    identifier TEXT NOT NULL, token TEXT NOT NULL UNIQUE, expires TEXT NOT NULL,
    UNIQUE(identifier, token)
  );

  CREATE TABLE IF NOT EXISTS novels (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, title TEXT NOT NULL, premise TEXT,
    genre TEXT NOT NULL DEFAULT 'Fantasy', tone TEXT, style TEXT,
    pov TEXT NOT NULL DEFAULT 'Third Person Limited', audience TEXT,
    targetWords INTEGER NOT NULL DEFAULT 80000,
    targetPages INTEGER NOT NULL DEFAULT 250,
    targetChapters INTEGER NOT NULL DEFAULT 30,
    writingMode TEXT NOT NULL DEFAULT 'chapter',
    status TEXT NOT NULL DEFAULT 'draft',
    stage TEXT NOT NULL DEFAULT 'create',
    coverImageId TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    approvedAt TEXT, completedAt TEXT,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(coverImageId) REFERENCES image_assets(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_novels_user_stage ON novels(userId, stage);
  CREATE INDEX IF NOT EXISTS idx_novels_user_status ON novels(userId, status);

  CREATE TABLE IF NOT EXISTS novel_settings (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL UNIQUE,
    fontFamily TEXT NOT NULL DEFAULT 'serif',
    fontSize INTEGER NOT NULL DEFAULT 12,
    lineSpacing REAL NOT NULL DEFAULT 1.6,
    margin INTEGER NOT NULL DEFAULT 72,
    pageSize TEXT NOT NULL DEFAULT 'letter',
    chapterHeadingStyle TEXT NOT NULL DEFAULT 'centered',
    pageNumbering TEXT NOT NULL DEFAULT 'bottom-center',
    includeFrontMatter INTEGER NOT NULL DEFAULT 1,
    includeToc INTEGER NOT NULL DEFAULT 1,
    coverPlacement TEXT NOT NULL DEFAULT 'front',
    wordsPerPage INTEGER NOT NULL DEFAULT 320,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS image_assets (
    id TEXT PRIMARY KEY, novelId TEXT, userId TEXT NOT NULL, kind TEXT NOT NULL,
    provider TEXT NOT NULL, storageKey TEXT NOT NULL, url TEXT NOT NULL,
    width INTEGER, height INTEGER, prompt TEXT, isPrimary INTEGER NOT NULL DEFAULT 0,
    meta TEXT, createdAt TEXT NOT NULL,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_images_novel_kind ON image_assets(novelId, kind);

  CREATE TABLE IF NOT EXISTS premises (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL UNIQUE,
    logline TEXT, shortSynopsis TEXT, fullSynopsis TEXT,
    themes TEXT, setting TEXT, majorConflicts TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS story_bibles (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL UNIQUE,
    overview TEXT, toneNotes TEXT, styleGuide TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
    age TEXT, appearance TEXT, personality TEXT, motivation TEXT, goals TEXT,
    fears TEXT, arc TEXT, backstory TEXT, avatarId TEXT, meta TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_characters_novel_role ON characters(novelId, role);

  CREATE TABLE IF NOT EXISTS character_relationships (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL, fromId TEXT NOT NULL, toId TEXT NOT NULL,
    relation TEXT NOT NULL, description TEXT,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE,
    FOREIGN KEY(fromId) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY(toId) REFERENCES characters(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT, kind TEXT, imageId TEXT, meta TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_locations_novel ON locations(novelId);

  CREATE TABLE IF NOT EXISTS world_rules (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT NOT NULL, category TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_world_rules_novel ON world_rules(novelId, category);

  CREATE TABLE IF NOT EXISTS timeline_events (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL, chapterId TEXT,
    label TEXT NOT NULL, description TEXT NOT NULL, "when" TEXT, orderIndex INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE,
    FOREIGN KEY(chapterId) REFERENCES chapters(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_timeline_novel_order ON timeline_events(novelId, orderIndex);

  CREATE TABLE IF NOT EXISTS plot_threads (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    introducedInChapterId TEXT, resolvedInChapterId TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_threads_novel_status ON plot_threads(novelId, status);

  CREATE TABLE IF NOT EXISTS story_acts (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL, actNumber INTEGER NOT NULL,
    name TEXT NOT NULL, description TEXT, purpose TEXT, turningPoint TEXT, orderIndex INTEGER NOT NULL,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_acts_novel_order ON story_acts(novelId, orderIndex);

  CREATE TABLE IF NOT EXISTS chapter_outlines (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL, actId TEXT, chapterNumber INTEGER NOT NULL,
    title TEXT NOT NULL, summary TEXT, narrativePurpose TEXT, majorEvents TEXT,
    charactersInvolved TEXT, location TEXT, conflict TEXT, emotionalObjective TEXT,
    plotAdvancement TEXT, foreshadowing TEXT,
    targetWords INTEGER NOT NULL, estimatedPages INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned', orderIndex INTEGER NOT NULL,
    UNIQUE(novelId, chapterNumber),
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE,
    FOREIGN KEY(actId) REFERENCES story_acts(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_outlines_novel_order ON chapter_outlines(novelId, orderIndex);

  CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL, outlineId TEXT UNIQUE,
    chapterNumber INTEGER NOT NULL, title TEXT NOT NULL,
    contentJson TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',
    contentHtml TEXT, plainText TEXT, status TEXT NOT NULL DEFAULT 'draft',
    wordCount INTEGER NOT NULL DEFAULT 0, pageCountEst INTEGER NOT NULL DEFAULT 0,
    summary TEXT, importantEvents TEXT, currentVersionId TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, approvedAt TEXT,
    UNIQUE(novelId, chapterNumber),
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE,
    FOREIGN KEY(outlineId) REFERENCES chapter_outlines(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chapters_novel_num ON chapters(novelId, chapterNumber);
  CREATE INDEX IF NOT EXISTS idx_chapters_novel_status ON chapters(novelId, status);

  CREATE TABLE IF NOT EXISTS chapter_versions (
    id TEXT PRIMARY KEY, chapterId TEXT NOT NULL, versionNum INTEGER NOT NULL,
    contentJson TEXT NOT NULL, wordCount INTEGER NOT NULL, note TEXT, createdAt TEXT NOT NULL,
    UNIQUE(chapterId, versionNum),
    FOREIGN KEY(chapterId) REFERENCES chapters(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_versions_chapter ON chapter_versions(chapterId);

  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL, chapterId TEXT, pageNumber INTEGER NOT NULL,
    contentJson TEXT NOT NULL, wordCount INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    UNIQUE(novelId, pageNumber),
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE,
    FOREIGN KEY(chapterId) REFERENCES chapters(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pages_novel_status ON pages(novelId, status);

  CREATE TABLE IF NOT EXISTS page_versions (
    id TEXT PRIMARY KEY, pageId TEXT NOT NULL, versionNum INTEGER NOT NULL,
    contentJson TEXT NOT NULL, wordCount INTEGER NOT NULL, createdAt TEXT NOT NULL,
    UNIQUE(pageId, versionNum),
    FOREIGN KEY(pageId) REFERENCES pages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS chapter_memories (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL, chapterId TEXT, characterId TEXT,
    kind TEXT NOT NULL, content TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 1,
    embedding TEXT, meta TEXT, createdAt TEXT NOT NULL,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE,
    FOREIGN KEY(chapterId) REFERENCES chapters(id) ON DELETE CASCADE,
    FOREIGN KEY(characterId) REFERENCES characters(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_novel_kind ON chapter_memories(novelId, kind);

  CREATE TABLE IF NOT EXISTS generation_jobs (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, novelId TEXT NOT NULL, taskType TEXT NOT NULL,
    payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', result TEXT, error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, maxAttempts INTEGER NOT NULL DEFAULT 3,
    idempotencyKey TEXT, startedAt TEXT, completedAt TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_novel_task ON generation_jobs(novelId, taskType, status);
  CREATE INDEX IF NOT EXISTS idx_jobs_user_date ON generation_jobs(userId, createdAt);

  CREATE TABLE IF NOT EXISTS consistency_issues (
    id TEXT PRIMARY KEY, novelId TEXT NOT NULL, chapterId TEXT,
    kind TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT NOT NULL, evidence TEXT, suggestion TEXT,
    status TEXT NOT NULL DEFAULT 'open', meta TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE,
    FOREIGN KEY(chapterId) REFERENCES chapters(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_issues_novel_status ON consistency_issues(novelId, status, severity);

  CREATE TABLE IF NOT EXISTS ai_usage (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, novelId TEXT, taskType TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL,
    promptTokens INTEGER NOT NULL DEFAULT 0, completionTokens INTEGER NOT NULL DEFAULT 0,
    totalTokens INTEGER NOT NULL DEFAULT 0, estimatedCostUsd REAL NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_usage_user_date ON ai_usage(userId, createdAt);

  CREATE TABLE IF NOT EXISTS exports (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, novelId TEXT NOT NULL,
    format TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    fileKey TEXT, fileUrl TEXT, fileSize INTEGER, options TEXT, error TEXT,
    createdAt TEXT NOT NULL, completedAt TEXT,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_exports_novel_date ON exports(novelId, createdAt);
  `);
}

export default getDb;
