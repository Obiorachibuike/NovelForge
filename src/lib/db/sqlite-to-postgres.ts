import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Pool, PoolClient } from 'pg';
import { runMigrations } from './migrations';
import { getPgPool, runPostgresMigrations, withPgTransaction } from './postgres';

export interface TableMigrationReport {
  table: string;
  sourceCount: number;
  migratedCount: number;
  targetCount: number;
}

export interface SqliteToPostgresMigrationReport {
  sqlitePath: string;
  backupPath: string | null;
  tables: TableMigrationReport[];
  verifiedRelationships: boolean;
  completedAt: string;
}

/**
 * Ordered list of application tables in foreign-key dependency order.
 */
export const MIGRATION_TABLE_ORDER = [
  'users',
  'accounts',
  'sessions',
  'verification_tokens',
  'novels',
  'novel_settings',
  'image_assets',
  'premises',
  'story_bibles',
  'characters',
  'character_relationships',
  'locations',
  'world_rules',
  'story_acts',
  'chapter_outlines',
  'chapters',
  'chapter_versions',
  'pages',
  'page_versions',
  'timeline_events',
  'plot_threads',
  'chapter_memories',
  'consistency_issues',
  'generation_jobs',
  'exports',
  'ai_usage',
  'subscriptions',
  'stripe_events',
  'admin_audit_log',
  'novel_backups',
] as const;

async function upsertRow(
  client: PoolClient,
  table: string,
  row: Record<string, unknown>,
  conflictColumns: string[] = ['id'],
) {
  const cols = Object.keys(row);
  if (!cols.length) return;
  const quotedCols = cols.map(c => (c === 'when' ? '"when"' : c));
  const placeholders = cols.map((_, idx) => `$${idx + 1}`);
  const values = cols.map(c => (row[c] === undefined ? null : row[c]));

  const updateCols = cols.filter(c => !conflictColumns.includes(c));
  const conflictTarget = conflictColumns.join(', ');
  const conflictClause = updateCols.length
    ? `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateCols
        .map(c => {
          const colName = c === 'when' ? '"when"' : c;
          return `${colName} = EXCLUDED.${colName}`;
        })
        .join(', ')}`
    : `ON CONFLICT (${conflictTarget}) DO NOTHING`;

  const sql = `INSERT INTO ${table} (${quotedCols.join(', ')}) VALUES (${placeholders.join(', ')}) ${conflictClause}`;
  await client.query(sql, values);
}

/**
 * Safely migrates all existing records from a SQLite database into PostgreSQL.
 *
 * - Creates a non-destructive backup of the SQLite file before reading;
 * - Never deletes the original SQLite database;
 * - Runs inside a PostgreSQL transaction (`BEGIN` / `COMMIT` / `ROLLBACK`);
 * - Uses `ON CONFLICT DO UPDATE` so re-running the migration is idempotent and
 *   never creates duplicate rows;
 * - Verifies row counts and foreign-key integrity before committing.
 */
export async function migrateSqliteToPostgres(options: {
  sqlitePath: string;
  pgPool?: Pool;
  createBackup?: boolean;
  log?: (msg: string) => void;
}): Promise<SqliteToPostgresMigrationReport> {
  const log = options.log || (() => {});
  const { sqlitePath } = options;

  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite source database not found at "${sqlitePath}".`);
  }

  let backupPath: string | null = null;
  if (options.createBackup !== false) {
    backupPath = `${sqlitePath}.pre-pg-migration.bak`;
    fs.copyFileSync(sqlitePath, backupPath);
    log(`[migrate] Created non-destructive SQLite backup at ${backupPath}`);
  }

  const sqlite = new Database(sqlitePath);
  sqlite.pragma('foreign_keys = ON');
  // Ensure the source SQLite database has all columns from the current schema
  runMigrations(sqlite);

  const pool = options.pgPool || getPgPool();
  await runPostgresMigrations(pool, log);

  const tableReports: TableMigrationReport[] = [];

  try {
    await withPgTransaction(async client => {
      for (const table of MIGRATION_TABLE_ORDER) {
        const exists = sqlite
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
          .get(table);
        if (!exists) continue;

        const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
        const conflictCols =
          table === 'verification_tokens' ? ['identifier', 'token'] : ['id'];

        for (const row of rows) {
          if (table === 'novels') {
            // Insert novels with coverImageId = NULL first, then restore coverImageId
            // after image_assets are migrated so cyclic references never fail.
            await upsertRow(client, table, { ...row, coverImageId: null }, conflictCols);
          } else if (table === 'chapters') {
            await upsertRow(client, table, { ...row, currentVersionId: null }, conflictCols);
          } else {
            await upsertRow(client, table, row, conflictCols);
          }
        }

        const countRes = await client.query(`SELECT COUNT(*) AS c FROM ${table}`);
        const targetCount = Number(countRes.rows[0]?.c ?? 0);
        if (targetCount < rows.length) {
          throw new Error(
            `Record count verification failed for table "${table}": source had ${rows.length} rows, target has ${targetCount}.`,
          );
        }

        tableReports.push({
          table,
          sourceCount: rows.length,
          migratedCount: rows.length,
          targetCount,
        });
        log(`[migrate] ${table}: ${rows.length} row(s) transferred (target total: ${targetCount})`);
      }

      // Restore deferred references (novels.coverImageId and chapters.currentVersionId)
      const novelsWithCover = sqlite
        .prepare('SELECT id, coverImageId FROM novels WHERE coverImageId IS NOT NULL')
        .all() as Array<{ id: string; coverImageId: string }>;
      for (const n of novelsWithCover) {
        await client.query('UPDATE novels SET coverImageId = $1 WHERE id = $2', [n.coverImageId, n.id]);
      }

      const chaptersWithVersion = sqlite
        .prepare('SELECT id, currentVersionId FROM chapters WHERE currentVersionId IS NOT NULL')
        .all() as Array<{ id: string; currentVersionId: string }>;
      for (const ch of chaptersWithVersion) {
        await client.query('UPDATE chapters SET currentVersionId = $1 WHERE id = $2', [
          ch.currentVersionId,
          ch.id,
        ]);
      }

      // Verify key relationships (every migrated novel belongs to a migrated user,
      // every migrated chapter belongs to a migrated novel)
      const orphanNovels = await client.query(
        'SELECT COUNT(*) AS c FROM novels n LEFT JOIN users u ON u.id = n.userId WHERE u.id IS NULL',
      );
      if (Number(orphanNovels.rows[0]?.c ?? 0) > 0) {
        throw new Error('Relationship verification failed: found novels without matching users.');
      }

      const orphanChapters = await client.query(
        'SELECT COUNT(*) AS c FROM chapters c LEFT JOIN novels n ON n.id = c.novelId WHERE n.id IS NULL',
      );
      if (Number(orphanChapters.rows[0]?.c ?? 0) > 0) {
        throw new Error('Relationship verification failed: found chapters without matching novels.');
      }
    }, pool);
  } finally {
    sqlite.close();
  }

  return {
    sqlitePath,
    backupPath,
    tables: tableReports,
    verifiedRelationships: true,
    completedAt: new Date().toISOString(),
  };
}
