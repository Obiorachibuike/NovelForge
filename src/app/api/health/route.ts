import { getDb, databaseStatus, isPostgresUrl } from '@/lib/db';
import { validateEnvConfig } from '@/lib/config/env';
import { classifyDatabaseError, databaseTarget, describeDatabaseFailure } from '@/lib/db/errors';
import { redactSecrets } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  const startedAt = Date.now();
  try {
    const config = validateEnvConfig();
    const db = getDb();
    const ping = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    if (ping?.ok !== 1) {
      throw new Error('Database ping failed');
    }

    const journalMode = db.pragma('journal_mode', { simple: true }) as string;
    const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    const migrations = databaseStatus();
    const latestVersion = migrations.applied.length
      ? migrations.applied[migrations.applied.length - 1].id
      : null;

    const queueRows = db
      .prepare('SELECT status, COUNT(*) AS count FROM generation_jobs GROUP BY status')
      .all() as Array<{ status: string; count: number }>;
    const queueCounts: Record<string, number> = {
      queued: 0,
      processing: 0,
      awaiting_review: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const r of queueRows) {
      queueCounts[r.status] = r.count;
    }

    return Response.json(
      {
        status: 'ok',
        timestamp: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        database: {
          driver: migrations.driver,
          connected: true,
          journalMode,
          foreignKeysEnabled: foreignKeys === 1,
          latestMigrationVersion: latestVersion,
          pendingMigrations: migrations.pending.length,
        },
        storage: {
          coverProvider: config.hasCloudinary ? 'cloudinary' : config.storageProvider,
        },
        queue: {
          status: migrations.pending.length === 0 ? 'healthy' : 'degraded',
          counts: queueCounts,
        },
        ai: {
          mode: config.hasOpenAiKey ? 'openai' : 'deterministic-demo',
        },
        // Transactional e-mail (Brevo): registration and password recovery
        // depend on it, so a probe should say whether it is usable.
        email: {
          provider: 'brevo',
          configured: config.emailDeliveryConfigured,
        },
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err: any) {
    // A readiness probe is only useful if it says *what* is broken: report the
    // concrete database/config failure (secret-free) instead of a generic text.
    const dbFailure = classifyDatabaseError(err);
    console.error(
      `[health] check failed${dbFailure ? ` (${describeDatabaseFailure(dbFailure)})` : ''}: ${redactSecrets(
        err instanceof Error ? err.message : String(err),
      )}`,
    );

    // Configuration errors raised by src/lib/config/env.ts are our own, safe,
    // actionable messages (missing env var, invalid storage provider, ...).
    const configMessage =
      !dbFailure && typeof err?.message === 'string' && err.message.startsWith('[config]')
        ? err.message.replace(/^\[config\]\s*/, '')
        : null;

    return Response.json(
      {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: dbFailure?.message ?? configMessage ?? 'Service health check failed',
        code: dbFailure
          ? // AUTH_SECRET problems are configuration, not a database outage.
            dbFailure.kind === 'configuration' && !/DATABASE_URL|database/i.test(dbFailure.message)
            ? 'invalid_configuration'
            : `database_${dbFailure.kind}`
          : configMessage
            ? 'invalid_configuration'
            : 'health_check_failed',
        hint:
          dbFailure?.hint ??
          (configMessage
            ? 'Fix the environment variable named above and redeploy/restart.'
            : 'Check the server logs for the underlying error.'),
        database: {
          driver: isPostgresUrl()
            ? 'postgres'
            : process.env.DATABASE_URL
              ? 'sqlite'
              : process.env.NODE_ENV === 'production'
                ? 'unconfigured'
                : 'sqlite',
          target: databaseTarget(),
          connected: false,
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
