import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Test environment.
 *
 * Every vitest worker process gets its own temporary SQLite database and data
 * directory, and the queue never dispatches in-process (tests drive jobs
 * explicitly so claims/retries can be asserted deterministically).
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `novelforge-test-${process.pid}-`));

// NODE_ENV is typed readonly; the test runner must run in test mode anyway.
(process.env as Record<string, string | undefined>).NODE_ENV = 'test';
process.env.DATABASE_URL = `file:${path.join(dir, 'novelforge.db')}`;
process.env.DATA_DIR = path.join(dir, 'data');
process.env.AUTH_SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
process.env.AUTH_TRUST_HOST = 'true';
process.env.STORAGE_PROVIDER = 'local';
// Demo mode by default: no test may make a paid provider call.
process.env.AI_DEMO_MODE = 'true';
delete process.env.OPENAI_API_KEY;
// Jobs must only run when a test asks for them.
process.env.QUEUE_NO_INPROCESS = '1';
process.env.AI_DAILY_TOKEN_LIMIT = '400000';
process.env.AI_MONTHLY_COST_LIMIT_USD = '25';
process.env.RATE_LIMIT_AI_PER_HOUR = '60';
process.env.RATE_LIMIT_EDITOR_PER_HOUR = '240';
process.env.RATE_LIMIT_IMAGE_PER_HOUR = '20';
process.env.RATE_LIMIT_EXPORT_PER_HOUR = '30';
process.env.RATE_LIMIT_REGISTER_PER_HOUR = '10';

// eslint-disable-next-line no-console
console.log(`[tests] database: ${process.env.DATABASE_URL}`);
