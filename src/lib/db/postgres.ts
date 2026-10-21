import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { migrations, type MigrationResult } from './migrations';
import { redactSecrets } from '@/lib/api/http';

/**
 * Canonical column-name map from PostgreSQL's folded lowercase identifiers back
 * to the camelCase property names used across NovelForge's TypeScript types.
 */
const CAMEL_CASE_COLUMNS: Record<string, string> = {
  userid: 'userId',
  novelid: 'novelId',
  chapterid: 'chapterId',
  outlineid: 'outlineId',
  actid: 'actId',
  characterid: 'characterId',
  imageid: 'imageId',
  coverimageid: 'coverImageId',
  avatarid: 'avatarId',
  pageid: 'pageId',
  fromid: 'fromId',
  toid: 'toId',
  actorid: 'actorId',
  targetuserid: 'targetUserId',
  jobid: 'jobId',
  lastjobid: 'lastJobId',
  currentversionid: 'currentVersionId',
  parentversionid: 'parentVersionId',
  introducedinchapterid: 'introducedInChapterId',
  resolvedinchapterid: 'resolvedInChapterId',
  emailverified: 'emailVerified',
  passwordhash: 'passwordHash',
  provideraccountid: 'providerAccountId',
  sessiontoken: 'sessionToken',
  freenovelaccess: 'freeNovelAccess',
  freenovelgrantedby: 'freeNovelGrantedBy',
  freenovelgrantedat: 'freeNovelGrantedAt',
  stripecustomerid: 'stripeCustomerId',
  stripesubscriptionid: 'stripeSubscriptionId',
  priceid: 'priceId',
  currentperiodend: 'currentPeriodEnd',
  cancelatperiodend: 'cancelAtPeriodEnd',
  processedat: 'processedAt',
  targetwords: 'targetWords',
  targetpages: 'targetPages',
  targetchapters: 'targetChapters',
  writingmode: 'writingMode',
  createdat: 'createdAt',
  updatedat: 'updatedAt',
  approvedat: 'approvedAt',
  completedat: 'completedAt',
  startedat: 'startedAt',
  claimedat: 'claimedAt',
  claimedby: 'claimedBy',
  scheduledat: 'scheduledAt',
  appliedat: 'appliedAt',
  generatedat: 'generatedAt',
  uploadedat: 'uploadedAt',
  fontfamily: 'fontFamily',
  fontsize: 'fontSize',
  linespacing: 'lineSpacing',
  pagesize: 'pageSize',
  chapterheadingstyle: 'chapterHeadingStyle',
  pagenumbering: 'pageNumbering',
  includefrontmatter: 'includeFrontMatter',
  includetoc: 'includeToc',
  coverplacement: 'coverPlacement',
  wordsperpage: 'wordsPerPage',
  storagekey: 'storageKey',
  isprimary: 'isPrimary',
  publicid: 'publicId',
  secureurl: 'secureUrl',
  shortsynopsis: 'shortSynopsis',
  fullsynopsis: 'fullSynopsis',
  majorconflicts: 'majorConflicts',
  tonenotes: 'toneNotes',
  styleguide: 'styleGuide',
  actnumber: 'actNumber',
  turningpoint: 'turningPoint',
  orderindex: 'orderIndex',
  chapternumber: 'chapterNumber',
  narrativepurpose: 'narrativePurpose',
  majorevents: 'majorEvents',
  charactersinvolved: 'charactersInvolved',
  emotionalobjective: 'emotionalObjective',
  plotadvancement: 'plotAdvancement',
  estimatedpages: 'estimatedPages',
  contentjson: 'contentJson',
  generatedcontentjson: 'generatedContentJson',
  contenthtml: 'contentHtml',
  plaintext: 'plainText',
  wordcount: 'wordCount',
  pagecountest: 'pageCountEst',
  importantevents: 'importantEvents',
  generationsource: 'generationSource',
  versionnum: 'versionNum',
  revisiontype: 'revisionType',
  pagenumber: 'pageNumber',
  tasktype: 'taskType',
  maxattempts: 'maxAttempts',
  idempotencykey: 'idempotencyKey',
  errorcode: 'errorCode',
  prompttokens: 'promptTokens',
  completiontokens: 'completionTokens',
  totaltokens: 'totalTokens',
  estimatedcostusd: 'estimatedCostUsd',
  estimatedcostbeforeusd: 'estimatedCostBeforeUsd',
  pricepromptper1k: 'pricePromptPer1k',
  pricecompletionper1k: 'priceCompletionPer1k',
  filekey: 'fileKey',
  fileurl: 'fileUrl',
  filesize: 'fileSize',
  mimetype: 'mimeType',
  formatversion: 'formatVersion',
  bytesize: 'byteSize',
  chaptercount: 'chapterCount',
  // ── AI model registry (migration 0008) ────────────────────────────────────
  availabilitystatus: 'availabilityStatus',
  pricingstatus: 'pricingStatus',
  contextlength: 'contextLength',
  supportedsizes: 'supportedSizes',
  supportsnegativeprompt: 'supportsNegativePrompt',
  verificationsource: 'verificationSource',
  verifiedat: 'verifiedAt',
  lastcheckedat: 'lastCheckedAt',
  lastsuccessfulat: 'lastSuccessfulAt',
  averagelatencyms: 'averageLatencyMs',
  successcount: 'successCount',
  disabledreason: 'disabledReason',
  
  modelid: 'modelId',
  latencyms: 'latencyMs',
  requestedmodel: 'requestedModel',
  actualmodel: 'actualModel',
  fallbackcount: 'fallbackCount',
  durationms: 'durationMs',
  attemptcount: 'attemptCount',
  coststatus: 'costStatus',
  confirmedcostusd: 'confirmedCostUsd',
  imagewidth: 'imageWidth',
  imageheight: 'imageHeight',
  // Computed alias columns in SELECT queries
  coverurl: 'coverUrl',
  wordswritten: 'wordsWritten',
  chapterscompleted: 'chaptersCompleted',
  chapterstotal: 'chaptersTotal',
  outlinesummary: 'outlineSummary',
  outlinetitle: 'outlineTitle',
  chaptername: 'chapterName',
  chaptertitle: 'chapterTitle',
  ownerid: 'ownerId',
  noveltitle: 'novelTitle',
  totalwords: 'totalWords',
  totalchapters: 'totalChapters',
  approvedwords: 'approvedWords',
  approvedchapters: 'approvedChapters',
};

export function isPostgresUrl(url: string | undefined = process.env.DATABASE_URL): boolean {
  if (!url) return false;
  return /^postgres(ql)?:\/\//i.test(url.trim());
}

export function redactConnectionString(url: string): string {
  if (!url) return '';
  return redactSecrets(url);
}

export function parsePostgresConfig(url = process.env.DATABASE_URL || ''): PoolConfig {
  const trimmed = url.trim();
  if (!isPostgresUrl(trimmed)) {
    throw new Error(
      'Invalid PostgreSQL connection string in DATABASE_URL. Expected postgres:// or postgresql:// URL.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Malformed PostgreSQL DATABASE_URL.');
  }
  if (!parsed.hostname) {
    throw new Error('PostgreSQL DATABASE_URL is missing a hostname.');
  }
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!dbName) {
    throw new Error('PostgreSQL DATABASE_URL is missing a database name.');
  }

  const max = Number(process.env.PG_POOL_MAX) > 0 ? Math.floor(Number(process.env.PG_POOL_MAX)) : 10;
  const idleTimeoutMillis =
    Number(process.env.PG_IDLE_TIMEOUT_MS) > 0 ? Math.floor(Number(process.env.PG_IDLE_TIMEOUT_MS)) : 30_000;
  const connectionTimeoutMillis =
    Number(process.env.PG_CONNECTION_TIMEOUT_MS) > 0
      ? Math.floor(Number(process.env.PG_CONNECTION_TIMEOUT_MS))
      : 10_000;

  const sslEnv = (process.env.PG_SSL || parsed.searchParams.get('sslmode') || '').toLowerCase();
  const ssl =
    sslEnv === 'true' || sslEnv === 'require'
      ? { rejectUnauthorized: true }
      : sslEnv === 'no-verify' || sslEnv === 'allow' || sslEnv === 'prefer'
        ? { rejectUnauthorized: false }
        : undefined;

  return {
    connectionString: trimmed,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    ...(ssl ? { ssl } : {}),
  };
}

let _pool: Pool | null = null;

export function getPgPool(url = process.env.DATABASE_URL): Pool {
  if (_pool) return _pool;
  const config = parsePostgresConfig(url);
  const pool = new Pool(config);
  pool.on('error', err => {
    console.error('[postgres] unexpected pool client error:', redactSecrets(err.message));
  });
  _pool = pool;
  return _pool;
}

/** Test seam: injects a mock or custom pg.Pool instance. */
export function __setPgPoolForTests(pool: Pool | null) {
  _pool = pool;
}

export async function closePgPool(): Promise<void> {
  if (_pool) {
    const p = _pool;
    _pool = null;
    await p.end().catch(() => {});
  }
}

export function normalizePgRow<T = Record<string, any>>(row: Record<string, any> | undefined | null): T | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    const mappedKey = CAMEL_CASE_COLUMNS[k] || k;
    // Coerce pg bigint COUNT/SUM strings to numbers when safe
    if (typeof v === 'string' && /^-?\d+$/.test(v) && (
      mappedKey === 'c' ||
      mappedKey === 'count' ||
      mappedKey === 'total' ||
      mappedKey === 'done' ||
      mappedKey === 'next' ||
      mappedKey === 'wordsWritten' ||
      mappedKey === 'chaptersCompleted' ||
      mappedKey === 'chaptersTotal' ||
      mappedKey === 'totalWords' ||
      mappedKey === 'totalChapters' ||
      mappedKey === 'approvedWords' ||
      mappedKey === 'approvedChapters' ||
      mappedKey === 'requests' ||
      mappedKey === 'promptTokens' ||
      mappedKey === 'completionTokens' ||
      mappedKey === 'totalTokens'
    )) {
      out[mappedKey] = Number(v);
    } else {
      out[mappedKey] = v;
    }
  }
  return out as T;
}

/**
 * Translates SQLite-style parameterized SQL (`?` or `@named` placeholders,
 * `INSERT OR IGNORE`, `REAL` DDL) into PostgreSQL syntax (`$1, $2, ...`,
 * `ON CONFLICT DO NOTHING`, `DOUBLE PRECISION`).
 */
export function translateSqlForPostgres(
  rawSql: string,
  args: unknown[] = [],
): { text: string; values: unknown[] } {
  let sql = rawSql.trim();

  // DDL type translation: SQLite `REAL` -> PostgreSQL `DOUBLE PRECISION`
  if (/^(CREATE|ALTER)\s+TABLE/i.test(sql)) {
    sql = sql.replace(/\bREAL\b/g, 'DOUBLE PRECISION');
  }

  // INSERT OR IGNORE INTO ... -> INSERT INTO ... ON CONFLICT DO NOTHING
  if (/^INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql)) {
    sql = sql.replace(/^INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    if (!/ON\s+CONFLICT/i.test(sql)) {
      sql = `${sql.replace(/;?\s*$/, '')} ON CONFLICT DO NOTHING`;
    }
  }

  // Flatten single array or named-parameter object argument
  const values: unknown[] = [];

  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0]) &&
    !(args[0] instanceof Buffer) &&
    !(args[0] instanceof Date) &&
    /@[A-Za-z_][A-Za-z0-9_]*/.test(sql)
  ) {
    const namedObj = args[0] as Record<string, unknown>;
    const paramIndexByKey = new Map<string, number>();
    const text = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_m, key: string) => {
      if (paramIndexByKey.has(key)) {
        return `$${paramIndexByKey.get(key)!}`;
      }
      values.push(namedObj[key] === undefined ? null : namedObj[key]);
      const idx = values.length;
      paramIndexByKey.set(key, idx);
      return `$${idx}`;
    });
    return { text, values };
  }

  const flatArgs = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  let paramCounter = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let out = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      out += ch;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      out += ch;
      continue;
    }
    if (ch === '?' && !inSingleQuote && !inDoubleQuote) {
      paramCounter++;
      out += `$${paramCounter}`;
      const rawVal = flatArgs[paramCounter - 1];
      values.push(rawVal === undefined ? null : rawVal);
      continue;
    }
    out += ch;
  }

  return { text: out, values };
}

export async function pgQuery<T = Record<string, any>>(
  sql: string,
  params: unknown[] = [],
  client?: PoolClient | Pool,
): Promise<T[]> {
  const executor = client || getPgPool();
  const { text, values } = translateSqlForPostgres(sql, params);
  const res = await executor.query(text, values);
  return (res.rows || []).map(r => normalizePgRow<T>(r)!);
}

export async function pgQueryOne<T = Record<string, any>>(
  sql: string,
  params: unknown[] = [],
  client?: PoolClient | Pool,
): Promise<T | undefined> {
  const rows = await pgQuery<T>(sql, params, client);
  return rows[0];
}

export async function pgExecute(
  sql: string,
  params: unknown[] = [],
  client?: PoolClient | Pool,
): Promise<{ changes: number }> {
  const executor = client || getPgPool();
  const { text, values } = translateSqlForPostgres(sql, params);
  const res = await executor.query(text, values);
  return { changes: res.rowCount ?? 0 };
}

/**
 * Runs an async callback inside a PostgreSQL transaction (`BEGIN` / `COMMIT` / `ROLLBACK`),
 * guaranteeing client release.
 */
export async function withPgTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  pool = getPgPool(),
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies all versioned NovelForge schema migrations to PostgreSQL inside
 * per-migration transactions. Safe and idempotent to run on every startup or deploy.
 */
export async function runPostgresMigrations(
  pool = getPgPool(),
  log: (msg: string) => void = () => {},
): Promise<MigrationResult> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      appliedAt TEXT NOT NULL
    )
  `);

  const existing = await pool.query('SELECT id FROM schema_migrations ORDER BY id ASC');
  const applied = new Set<string>(existing.rows.map((r: any) => r.id));

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      result.skipped.push(migration.id);
      continue;
    }
    await withPgTransaction(async client => {
      for (const stmt of migration.statements) {
        const { text } = translateSqlForPostgres(stmt);
        await client.query(text);
      }
      await client.query(
        'INSERT INTO schema_migrations (id, description, appliedAt) VALUES ($1, $2, $3)',
        [migration.id, migration.description, new Date().toISOString()],
      );
    }, pool);
    result.applied.push(migration.id);
    log(`[postgres] applied migration ${migration.id} — ${migration.description}`);
  }

  return result;
}

export async function postgresMigrationStatus(pool = getPgPool()) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      appliedAt TEXT NOT NULL
    )
  `);
  const res = await pool.query('SELECT id, appliedAt FROM schema_migrations ORDER BY id ASC');
  const rows = res.rows.map(r => normalizePgRow<{ id: string; appliedAt: string }>(r)!);
  const appliedIds = new Set(rows.map(r => r.id));
  return {
    applied: rows,
    pending: migrations.filter(m => !appliedIds.has(m.id)).map(m => m.id),
  };
}

export async function checkPostgresHealth(pool = getPgPool()): Promise<{
  connected: boolean;
  latestMigrationVersion: string | null;
  pendingMigrations: number;
}> {
  const ping = await pool.query('SELECT 1 AS ok');
  if (ping.rows?.[0]?.ok !== 1) {
    throw new Error('PostgreSQL ping failed');
  }
  const status = await postgresMigrationStatus(pool);
  const latest = status.applied.length ? status.applied[status.applied.length - 1].id : null;
  return {
    connected: true,
    latestMigrationVersion: latest,
    pendingMigrations: status.pending.length,
  };
}
