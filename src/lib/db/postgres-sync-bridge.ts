import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import {
  parsePostgresConfig,
  translateSqlForPostgres,
  normalizePgRow,
} from './postgres';
import { migrations, type MigrationResult } from './migrations';

export interface PgSyncQueryResult {
  rows: Record<string, any>[];
  rowCount: number;
}

export interface PgSyncExecutor {
  query(text: string, values: unknown[]): PgSyncQueryResult;
  begin(): void;
  commit(): void;
  rollback(): void;
  close(): void;
}

let _testExecutorFactory: ((connectionString: string) => PgSyncExecutor) | null = null;

/**
 * Test seam: allows unit tests to attach a custom PostgreSQL executor to verify
 * the synchronous `getDb()` PostgreSQL path deterministically.
 */
export function __setPgSyncExecutorFactoryForTests(
  factory: ((connectionString: string) => PgSyncExecutor) | null,
) {
  _testExecutorFactory = factory;
}

const WORKER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const { Pool } = require('pg');

const pool = new Pool(workerData.poolConfig);
const replyPort = workerData.port;
let txClient = null;

pool.on('error', () => {});

parentPort.on('message', async (msg) => {
  const { sab, op, text, values } = msg;
  const int32 = new Int32Array(sab);
  const send = (payload) => {
    replyPort.postMessage(payload);
    Atomics.store(int32, 0, 1);
    Atomics.notify(int32, 0, 1);
  };

  try {
    if (op === 'begin') {
      if (!txClient) {
        txClient = await pool.connect();
        await txClient.query('BEGIN');
      }
      send({ ok: true, rows: [], rowCount: 0 });
      return;
    }
    if (op === 'commit') {
      if (txClient) {
        try {
          await txClient.query('COMMIT');
        } finally {
          txClient.release();
          txClient = null;
        }
      }
      send({ ok: true, rows: [], rowCount: 0 });
      return;
    }
    if (op === 'rollback') {
      if (txClient) {
        try {
          await txClient.query('ROLLBACK');
        } catch {} finally {
          txClient.release();
          txClient = null;
        }
      }
      send({ ok: true, rows: [], rowCount: 0 });
      return;
    }
    if (op === 'close') {
      if (txClient) {
        try { txClient.release(); } catch {}
        txClient = null;
      }
      await pool.end().catch(() => {});
      send({ ok: true, rows: [], rowCount: 0 });
      process.exit(0);
      return;
    }
    const runner = txClient || pool;
    const res = await runner.query(text, values || []);
    send({
      ok: true,
      rows: res.rows || [],
      rowCount: typeof res.rowCount === 'number' ? res.rowCount : (res.rows ? res.rows.length : 0),
    });
  } catch (err) {
    send({
      ok: false,
      error: err && err.message ? err.message : String(err),
      code: err && err.code ? err.code : undefined,
    });
  }
});
`;

function createWorkerExecutor(connectionString: string): PgSyncExecutor {
  const poolConfig = parsePostgresConfig(connectionString);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WORKER_SCRIPT, {
    eval: true,
    workerData: { poolConfig, port: port2 },
    transferList: [port2],
  });
  worker.unref();

  const timeoutMs = poolConfig.connectionTimeoutMillis || 15_000;

  const callWorker = (
    op: 'query' | 'begin' | 'commit' | 'rollback' | 'close',
    text?: string,
    values?: unknown[],
  ): PgSyncQueryResult => {
    const sab = new SharedArrayBuffer(4);
    const int32 = new Int32Array(sab);
    worker.postMessage({ sab, op, text, values });
    const waitRes = Atomics.wait(int32, 0, 0, timeoutMs);
    if (waitRes === 'timed-out') {
      throw new Error(`PostgreSQL query timed out after ${timeoutMs}ms.`);
    }
    const msg = receiveMessageOnPort(port1)?.message;
    if (!msg) {
      throw new Error('PostgreSQL worker returned no response.');
    }
    if (!msg.ok) {
      const err = new Error(msg.error || 'PostgreSQL query failed') as Error & { code?: string };
      if (msg.code) err.code = msg.code;
      throw err;
    }
    return { rows: msg.rows || [], rowCount: msg.rowCount ?? 0 };
  };

  return {
    query: (text, values) => callWorker('query', text, values),
    begin: () => {
      callWorker('begin');
    },
    commit: () => {
      callWorker('commit');
    },
    rollback: () => {
      callWorker('rollback');
    },
    close: () => {
      try {
        callWorker('close');
      } catch {
        // ignore close errors
      }
      try {
        port1.close();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Synchronous Database-compatible wrapper backed by PostgreSQL (`pg.Pool`).
 * Implements the subset of `better-sqlite3`'s API used across NovelForge:
 *   - `prepare(sql).get/all/run(...)`
 *   - `exec(sql)`
 *   - `transaction(fn)`
 *   - `pragma(name, opts)`
 *   - `backup(destPath)`
 *   - `close()`
 */
export function createPostgresSyncDatabase(
  connectionString: string,
  log: (msg: string) => void = () => {},
): any {
  const executor = _testExecutorFactory
    ? _testExecutorFactory(connectionString)
    : createWorkerExecutor(connectionString);

  let txDepth = 0;

  const db = {
    driver: 'postgres' as const,

    prepare(sql: string) {
      return {
        get(...args: unknown[]) {
          const { text, values } = translateSqlForPostgres(sql, args);
          const res = executor.query(text, values);
          return normalizePgRow(res.rows[0]);
        },
        all(...args: unknown[]) {
          const { text, values } = translateSqlForPostgres(sql, args);
          const res = executor.query(text, values);
          return res.rows.map(r => normalizePgRow(r)!);
        },
        run(...args: unknown[]) {
          const { text, values } = translateSqlForPostgres(sql, args);
          const res = executor.query(text, values);
          return { changes: res.rowCount, lastInsertRowid: 0 };
        },
      };
    },

    exec(sql: string) {
      const { text } = translateSqlForPostgres(sql);
      executor.query(text, []);
      return db;
    },

    pragma(pragmaStr: string, opts?: { simple?: boolean }) {
      const lower = pragmaStr.toLowerCase();
      if (lower.startsWith('journal_mode')) {
        return opts?.simple ? 'wal' : [{ journal_mode: 'wal' }];
      }
      if (lower.startsWith('foreign_keys')) {
        return opts?.simple ? 1 : [{ foreign_keys: 1 }];
      }
      return opts?.simple ? 0 : [];
    },

    transaction<T extends (...args: any[]) => any>(fn: T): T {
      const wrapped = ((...args: Parameters<T>): ReturnType<T> => {
        const isOuter = txDepth === 0;
        txDepth++;
        if (isOuter) executor.begin();
        try {
          const out = fn(...args);
          if (isOuter) executor.commit();
          return out;
        } catch (err) {
          if (isOuter) {
            try {
              executor.rollback();
            } catch {
              // ignore rollback failure
            }
          }
          throw err;
        } finally {
          txDepth--;
        }
      }) as T;
      return wrapped;
    },

    async backup(destinationPath: string) {
      const fs = await import('node:fs');
      const snapshot = {
        driver: 'postgres',
        exportedAt: new Date().toISOString(),
        migrations: db.prepare('SELECT * FROM schema_migrations ORDER BY id').all(),
      };
      fs.writeFileSync(destinationPath, JSON.stringify(snapshot, null, 2), 'utf8');
    },

    close() {
      executor.close();
    },
  };

  runMigrationsOnSyncPg(db, log);
  return db;
}

export function runMigrationsOnSyncPg(db: any, log: (msg: string) => void = () => {}): MigrationResult {
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
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db.prepare('INSERT INTO schema_migrations (id, description, appliedAt) VALUES (?,?,?)').run(
        migration.id,
        migration.description,
        new Date().toISOString(),
      );
    });
    tx();
    result.applied.push(migration.id);
    log(`[postgres] applied migration ${migration.id} — ${migration.description}`);
  }
  return result;
}
