import { isPostgresUrl, parsePostgresConfig } from '@/lib/db/postgres';
import { isCloudinaryConfigured } from '@/services/covers/cloudinary-cover-service';
import { aiBackend, huggingFaceConfigured, validateAiConfig } from '@/lib/ai/config';

export interface ValidatedEnvConfig {
  nodeEnv: 'development' | 'production' | 'test';
  databaseDriver: 'postgres' | 'sqlite';
  sqlitePath: string;
  storageProvider: 'local' | 's3' | 'cloudinary';
  aiDailyTokenLimit: number;
  aiMonthlyCostLimitUsd: number;
  aiTimeoutMs: number;
  hasOpenAiKey: boolean;
  hasRedisUrl: boolean;
  hasCloudinary: boolean;
  hasHuggingFaceToken: boolean;
  aiBackend: 'huggingface' | 'openai' | 'demo';
  allowPaidInference: boolean;
  requireConfirmedPricing: boolean;
  aiProblems: string[];
}

const KNOWN_DEV_SECRETS = new Set([
  'dev-secret-change-in-production-min-32-chars-novelforge-key',
  'replace-with-openssl-rand-base64-32',
  'replace-with-a-long-random-secret',
  'changeme',
  'secret',
]);

/**
 * Validates required and optional environment variables.
 * Throws a descriptive error if critical configuration is missing or invalid.
 */
export function validateEnvConfig(env: NodeJS.ProcessEnv = process.env): ValidatedEnvConfig {
  const rawNodeEnv = env.NODE_ENV || 'development';
  const nodeEnv = (['development', 'production', 'test'].includes(rawNodeEnv)
    ? rawNodeEnv
    : 'development') as ValidatedEnvConfig['nodeEnv'];

  const isProdRuntime =
    nodeEnv === 'production' && env.NEXT_PHASE !== 'phase-production-build';

  if (isProdRuntime) {
    const authSecret = env.AUTH_SECRET || env.NEXTAUTH_SECRET || '';
    if (!authSecret || authSecret.length < 32 || KNOWN_DEV_SECRETS.has(authSecret)) {
      throw new Error(
        '[config] AUTH_SECRET must be set to a unique random secret of at least 32 characters in production.',
      );
    }
  }

  const dbUrl = env.DATABASE_URL?.trim() || '';
  let databaseDriver: 'postgres' | 'sqlite' = 'sqlite';
  if (isPostgresUrl(dbUrl)) {
    parsePostgresConfig(dbUrl);
    databaseDriver = 'postgres';
  } else if (isProdRuntime && env.ALLOW_SQLITE_IN_PRODUCTION !== 'true') {
    throw new Error(
      '[config] DATABASE_URL must be a PostgreSQL connection string (postgresql://...) in production. Never silently falling back to SQLite.',
    );
  }

  const storageProvider = (env.STORAGE_PROVIDER || env.FILE_STORAGE_DRIVER || 'local') as 'local' | 's3' | 'cloudinary';
  if (storageProvider !== 'local' && storageProvider !== 's3' && storageProvider !== 'cloudinary') {
    throw new Error(
      `[config] Invalid STORAGE_PROVIDER "${storageProvider}". Must be "local", "s3", or "cloudinary".`,
    );
  }
  if (storageProvider === 's3') {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error(
        '[config] STORAGE_PROVIDER="s3" requires S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY.',
      );
    }
  }

  // Validate partial or required Cloudinary credentials
  const hasAnyCloudinaryVar = Boolean(
    env.CLOUDINARY_CLOUD_NAME?.trim() ||
      env.CLOUDINARY_API_KEY?.trim() ||
      env.CLOUDINARY_API_SECRET?.trim(),
  );
  const hasFullCloudinary = isCloudinaryConfigured(env);
  if ((storageProvider === 'cloudinary' || hasAnyCloudinaryVar) && !hasFullCloudinary) {
    throw new Error(
      '[config] Cloudinary configuration requires CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.',
    );
  }

  const rawDailyTokens = env.AI_DAILY_TOKEN_LIMIT !== undefined ? Number(env.AI_DAILY_TOKEN_LIMIT) : 400_000;
  if (!Number.isFinite(rawDailyTokens) || rawDailyTokens < 0) {
    throw new Error('[config] AI_DAILY_TOKEN_LIMIT must be a non-negative number.');
  }

  const rawMonthlyCost =
    env.AI_MONTHLY_COST_LIMIT_USD !== undefined
      ? Number(env.AI_MONTHLY_COST_LIMIT_USD)
      : env.AI_MONTHLY_BUDGET_USD !== undefined
        ? Number(env.AI_MONTHLY_BUDGET_USD)
        : 25;
  if (!Number.isFinite(rawMonthlyCost) || rawMonthlyCost < 0) {
    throw new Error('[config] AI_MONTHLY_COST_LIMIT_USD must be a non-negative number.');
  }

  const rawTimeout =
    env.AI_TIMEOUT_MS !== undefined
      ? Number(env.AI_TIMEOUT_MS)
      : env.AI_REQUEST_TIMEOUT_MS !== undefined
        ? Number(env.AI_REQUEST_TIMEOUT_MS)
        : 90_000;
  if (!Number.isFinite(rawTimeout) || rawTimeout < 1_000) {
    throw new Error('[config] AI_TIMEOUT_MS must be a number >= 1000.');
  }

  const sqlitePath =
    env.SQLITE_PATH ||
    (dbUrl.startsWith('file:') ? dbUrl.replace(/^file:/, '') : '') ||
    './prisma/dev.db';

  const aiProblems = validateAiConfig(env);
  if (aiProblems.length) {
    // AI misconfiguration must not crash unrelated pages: report it once, and
    // let the AI endpoints return a precise configuration error.
    console.warn(`[config] AI configuration problems:\n- ${aiProblems.join('\n- ')}`);
  }

  return {
    nodeEnv,
    databaseDriver,
    sqlitePath,
    storageProvider,
    aiDailyTokenLimit: rawDailyTokens,
    aiMonthlyCostLimitUsd: rawMonthlyCost,
    aiTimeoutMs: rawTimeout,
    hasOpenAiKey: Boolean(env.OPENAI_API_KEY && !env.OPENAI_API_KEY.startsWith('sk-...')),
    hasRedisUrl: Boolean(env.REDIS_URL),
    hasCloudinary: hasFullCloudinary,
    hasHuggingFaceToken: huggingFaceConfigured(),
    aiBackend: aiBackend(),
    allowPaidInference: env.AI_ALLOW_PAID_INFERENCE !== 'false',
    requireConfirmedPricing: env.AI_REQUIRE_CONFIRMED_PRICING !== 'false',
    aiProblems,
  };
}
