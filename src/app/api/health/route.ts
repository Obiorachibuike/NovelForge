import { getDb, databaseStatus } from '@/lib/db';
import { validateEnvConfig } from '@/lib/config/env';

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
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err: any) {
    return Response.json(
      {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: 'Service health check failed',
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
