import type { Database } from 'better-sqlite3';

/**
 * Versioned, ordered, idempotent migrations.
 *
 * Every migration runs at most once per database and is recorded in
 * `schema_migrations`. Each migration is applied inside a transaction, so a
 * failure leaves the database exactly as it was and the migration can be
 * retried. Statements must use `IF NOT EXISTS` where a fresh database and an
 * existing database could differ, and additive `ALTER TABLE` statements are
 * only safe because the version guard guarantees single execution.
 *
 * Migration 0001 is the original schema that `src/lib/db/index.ts` used to
 * create inline with `CREATE TABLE IF NOT EXISTS`. It is reproduced verbatim so
 * databases created before this file existed (where the tables are already
 * present and `schema_migrations` is empty) are adopted without data loss.
 */
export interface Migration {
  id: string;
  description: string;
  statements: string[];
}

export const migrations: Migration[] = [
  {
    id: '0001_initial_schema',
    description: 'Original NovelForge schema (users, novels, chapters, jobs, exports, ai_usage).',
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, emailVerified TEXT,
        image TEXT, passwordHash TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL,
        provider TEXT NOT NULL, providerAccountId TEXT NOT NULL,
        refresh_token TEXT, access_token TEXT, expires_at INTEGER,
        token_type TEXT, scope TEXT, id_token TEXT, session_state TEXT,
        UNIQUE(provider, providerAccountId),
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, sessionToken TEXT UNIQUE NOT NULL,
        userId TEXT NOT NULL, expires TEXT NOT NULL,
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS verification_tokens (
        identifier TEXT NOT NULL, token TEXT NOT NULL UNIQUE, expires TEXT NOT NULL,
        UNIQUE(identifier, token)
      )`,
      `CREATE TABLE IF NOT EXISTS novels (
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
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_novels_user_stage ON novels(userId, stage)`,
      `CREATE INDEX IF NOT EXISTS idx_novels_user_status ON novels(userId, status)`,
      `CREATE TABLE IF NOT EXISTS novel_settings (
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
      )`,
      `CREATE TABLE IF NOT EXISTS image_assets (
        id TEXT PRIMARY KEY, novelId TEXT, userId TEXT NOT NULL, kind TEXT NOT NULL,
        provider TEXT NOT NULL, storageKey TEXT NOT NULL, url TEXT NOT NULL,
        width INTEGER, height INTEGER, prompt TEXT, isPrimary INTEGER NOT NULL DEFAULT 0,
        meta TEXT, createdAt TEXT NOT NULL,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_images_novel_kind ON image_assets(novelId, kind)`,
      `CREATE TABLE IF NOT EXISTS premises (
        id TEXT PRIMARY KEY, novelId TEXT NOT NULL UNIQUE,
        logline TEXT, shortSynopsis TEXT, fullSynopsis TEXT,
        themes TEXT, setting TEXT, majorConflicts TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS story_bibles (
        id TEXT PRIMARY KEY, novelId TEXT NOT NULL UNIQUE,
        overview TEXT, toneNotes TEXT, styleGuide TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY, novelId TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
        age TEXT, appearance TEXT, personality TEXT, motivation TEXT, goals TEXT,
        fears TEXT, arc TEXT, backstory TEXT, avatarId TEXT, meta TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_characters_novel_role ON characters(novelId, role)`,
      `CREATE TABLE IF NOT EXISTS character_relationships (
        id TEXT PRIMARY KEY, novelId TEXT NOT NULL, fromId TEXT NOT NULL, toId TEXT NOT NULL,
        relation TEXT NOT NULL, description TEXT,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE,
        FOREIGN KEY(fromId) REFERENCES characters(id) ON DELETE CASCADE,
        FOREIGN KEY(toId) REFERENCES characters(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS locations (
        id TEXT PRIMARY KEY, novelId TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT, kind TEXT, imageId TEXT, meta TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_locations_novel ON locations(novelId)`,
      `CREATE TABLE IF NOT EXISTS world_rules (
        id TEXT PRIMARY KEY, novelId TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL, category TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_world_rules_novel ON world_rules(novelId, category)`,
      `CREATE TABLE IF NOT EXISTS story_acts (
        id TEXT PRIMARY KEY, novelId TEXT NOT NULL, actNumber INTEGER NOT NULL,
        name TEXT NOT NULL, description TEXT, purpose TEXT, turningPoint TEXT, orderIndex INTEGER NOT NULL,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_acts_novel_order ON story_acts(novelId, orderIndex)`,
      `CREATE TABLE IF NOT EXISTS chapter_outlines (
        id TEXT PRIMARY KEY, novelId TEXT NOT NULL, actId TEXT, chapterNumber INTEGER NOT NULL,
        title TEXT NOT NULL, summary TEXT, narrativePurpose TEXT, majorEvents TEXT,
        charactersInvolved TEXT, location TEXT, conflict TEXT, emotionalObjective TEXT,
        plotAdvancement TEXT, foreshadowing TEXT,
        targetWords INTEGER NOT NULL, estimatedPages INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned', orderIndex INTEGER NOT NULL,
        UNIQUE(novelId, chapterNumber),
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE,
        FOREIGN KEY(actId) REFERENCES story_acts(id) ON DELETE SET NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_outlines_novel_order ON chapter_outlines(novelId, orderIndex)`,
      `CREATE TABLE IF NOT EXISTS chapters (
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
      )`,
      `CREATE INDEX IF NOT EXISTS idx_chapters_novel_num ON chapters(novelId, chapterNumber)`,
      `CREATE INDEX IF NOT EXISTS idx_chapters_novel_status ON chapters(novelId, status)`,
      `CREATE TABLE IF NOT EXISTS chapter_versions (
        id TEXT PRIMARY KEY, chapterId TEXT NOT NULL, versionNum INTEGER NOT NULL,
        contentJson TEXT NOT NULL, wordCount INTEGER NOT NULL, note TEXT, createdAt TEXT NOT NULL,
        UNIQUE(chapterId, versionNum),
        FOREIGN KEY(chapterId) REFERENCES chapters(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_versions_chapter ON chapter_versions(chapterId)`,
      `CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY, novelId TEXT NOT NULL, chapterId TEXT, pageNumber INTEGER NOT NULL,
        contentJson TEXT NOT NULL, wordCount INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        UNIQUE(novelId, pageNumber),
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE,
        FOREIGN KEY(chapterId) REFERENCES chapters(id) ON DELETE SET NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pages_novel_status ON pages(novelId, status)`,
      `CREATE TABLE IF NOT EXISTS page_versions (
        id TEXT PRIMARY KEY, pageId TEXT NOT NULL, versionNum INTEGER NOT NULL,
        contentJson TEXT NOT NULL, wordCount INTEGER NOT NULL, createdAt TEXT NOT NULL,
        UNIQUE(pageId, versionNum),
        FOREIGN KEY(pageId) REFERENCES pages(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS timeline_events (
        id TEXT PRIMARY KEY, novelId TEXT NOT NULL, chapterId TEXT,
        label TEXT NOT NULL, description TEXT NOT NULL, "when" TEXT, orderIndex INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE,
        FOREIGN KEY(chapterId) REFERENCES chapters(id) ON DELETE SET NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_timeline_novel_order ON timeline_events(novelId, orderIndex)`,
      `CREATE TABLE IF NOT EXISTS plot_threads (
        id TEXT PRIMARY KEY, novelId TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        introducedInChapterId TEXT, resolvedInChapterId TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_threads_novel_status ON plot_threads(novelId, status)`,
      `CREATE TABLE IF NOT EXISTS chapter_memories (
        id TEXT PRIMARY KEY, novelId TEXT NOT NULL, chapterId TEXT, characterId TEXT,
        kind TEXT NOT NULL, content TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 1,
        embedding TEXT, meta TEXT, createdAt TEXT NOT NULL,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE,
        FOREIGN KEY(chapterId) REFERENCES chapters(id) ON DELETE CASCADE,
        FOREIGN KEY(characterId) REFERENCES characters(id) ON DELETE SET NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memories_novel_kind ON chapter_memories(novelId, kind)`,
      `CREATE TABLE IF NOT EXISTS generation_jobs (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL, novelId TEXT NOT NULL, taskType TEXT NOT NULL,
        payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', result TEXT, error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, maxAttempts INTEGER NOT NULL DEFAULT 3,
        idempotencyKey TEXT, startedAt TEXT, completedAt TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_novel_task ON generation_jobs(novelId, taskType, status)`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_user_date ON generation_jobs(userId, createdAt)`,
      `CREATE TABLE IF NOT EXISTS consistency_issues (
        id TEXT PRIMARY KEY, novelId TEXT NOT NULL, chapterId TEXT,
        kind TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL, evidence TEXT, suggestion TEXT,
        status TEXT NOT NULL DEFAULT 'open', meta TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE,
        FOREIGN KEY(chapterId) REFERENCES chapters(id) ON DELETE SET NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_issues_novel_status ON consistency_issues(novelId, status, severity)`,
      `CREATE TABLE IF NOT EXISTS ai_usage (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL, novelId TEXT, taskType TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL,
        promptTokens INTEGER NOT NULL DEFAULT 0, completionTokens INTEGER NOT NULL DEFAULT 0,
        totalTokens INTEGER NOT NULL DEFAULT 0, estimatedCostUsd REAL NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_usage_user_date ON ai_usage(userId, createdAt)`,
      `CREATE TABLE IF NOT EXISTS exports (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL, novelId TEXT NOT NULL,
        format TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        fileKey TEXT, fileUrl TEXT, fileSize INTEGER, options TEXT, error TEXT,
        createdAt TEXT NOT NULL, completedAt TEXT,
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(novelId) REFERENCES novels(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_exports_novel_date ON exports(novelId, createdAt)`,
    ],
  },
  {
    id: '0002_job_claims_and_backoff',
    description: 'Atomic job claiming, retry scheduling and per-job progress.',
    statements: [
      `ALTER TABLE generation_jobs ADD COLUMN claimedAt TEXT`,
      `ALTER TABLE generation_jobs ADD COLUMN claimedBy TEXT`,
      `ALTER TABLE generation_jobs ADD COLUMN scheduledAt TEXT`,
      `ALTER TABLE generation_jobs ADD COLUMN progress INTEGER NOT NULL DEFAULT 0`,
      // A job may only be claimed while it is queued or processing; stale rows are
      // reclaimed by the recovery sweep, which clears claimedBy.
      `CREATE INDEX IF NOT EXISTS idx_jobs_claim ON generation_jobs(status, scheduledAt)`,
    ],
  },
  {
    id: '0003_job_idempotency_unique',
    description: 'Database-enforced idempotency for active jobs and generation provenance.',
    statements: [
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_active_idempotency
         ON generation_jobs(idempotencyKey)
         WHERE idempotencyKey IS NOT NULL AND status IN ('queued','processing')`,
      `ALTER TABLE chapters ADD COLUMN generationSource TEXT`,
      `ALTER TABLE chapters ADD COLUMN generatedAt TEXT`,
      `ALTER TABLE exports ADD COLUMN mimeType TEXT`,
    ],
  },
  {
    id: '0004_ai_usage_details',
    description: 'Richer AI usage accounting (pricing snapshot, task metadata, demo/failure markers).',
    statements: [
      `ALTER TABLE ai_usage ADD COLUMN pricePromptPer1k REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE ai_usage ADD COLUMN priceCompletionPer1k REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE ai_usage ADD COLUMN source TEXT NOT NULL DEFAULT 'openai'`,
      `ALTER TABLE ai_usage ADD COLUMN meta TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_usage_user_task ON ai_usage(userId, taskType, createdAt)`,
    ],
  },
  {
    id: '0005_billing_and_roles',
    description: 'Roles, free-access comps, Stripe subscriptions/events and an admin audit log.',
    statements: [
      // Roles and comps. `freeNovelAccess` is granted only through the admin API
      // or the ADMIN_EMAILS bootstrap; registration never sets it.
      `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`,
      `ALTER TABLE users ADD COLUMN freeNovelAccess INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN freeNovelGrantedBy TEXT`,
      `ALTER TABLE users ADD COLUMN freeNovelGrantedAt TEXT`,
      `ALTER TABLE users ADD COLUMN stripeCustomerId TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`,
      `CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        plan TEXT NOT NULL,
        status TEXT NOT NULL,
        stripeCustomerId TEXT,
        stripeSubscriptionId TEXT UNIQUE,
        priceId TEXT,
        currentPeriodEnd TEXT,
        cancelAtPeriodEnd INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(userId)`,
      // Webhook idempotency: an event id is recorded once, so a retried
      // delivery cannot grant a second entitlement or double-apply a change.
      `CREATE TABLE IF NOT EXISTS stripe_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        processedAt TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS admin_audit_log (
        id TEXT PRIMARY KEY,
        actorId TEXT NOT NULL,
        targetUserId TEXT,
        action TEXT NOT NULL,
        details TEXT,
        createdAt TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_log(targetUserId)`,
    ],
  },
];

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** Applies every pending migration in order and records it in schema_migrations. */
export function runMigrations(db: Database, log: (msg: string) => void = () => {}): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    appliedAt TEXT NOT NULL
  )`);

  const applied = new Set<string>(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map(r => r.id),
  );

  const result: MigrationResult = { applied: [], skipped: [] };
  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      result.skipped.push(migration.id);
      continue;
    }
    const tx = db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare('INSERT INTO schema_migrations (id, description, appliedAt) VALUES (?,?,?)')
        .run(migration.id, migration.description, new Date().toISOString());
    });
    tx();
    result.applied.push(migration.id);
    log(`[db] applied migration ${migration.id} — ${migration.description}`);
  }
  return result;
}

/** Which migrations this build knows about and which are present in the database. */
export function migrationStatus(db: Database) {
  const rows = db.prepare('SELECT id, appliedAt FROM schema_migrations ORDER BY id').all() as
    { id: string; appliedAt: string }[];
  const appliedIds = new Set(rows.map(r => r.id));
  return {
    applied: rows,
    pending: migrations.filter(m => !appliedIds.has(m.id)).map(m => m.id),
  };
}
