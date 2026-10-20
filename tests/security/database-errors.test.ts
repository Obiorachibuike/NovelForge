import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyDatabaseError, databaseTarget } from '@/lib/db/errors';
import { errorResponse } from '@/lib/api/http';
import { resetDbForTests } from '@/lib/db';
import { resetRateLimitsForTests } from '@/lib/security/rate-limit';
import { POST as register } from '@/app/api/auth/register/route';

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const pgError = (code: string, message = 'driver said no') =>
  Object.assign(new Error(message), { code });

beforeEach(() => {
  resetRateLimitsForTests();
});

afterEach(() => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  resetDbForTests();
});

describe('database failure classification', () => {
  it('recognises a refused connection and names the target without credentials', () => {
    process.env.DATABASE_URL = 'postgresql://writer:hunter2@127.0.0.1:5432/novelforge';
    const failure = classifyDatabaseError(pgError('ECONNREFUSED'));

    expect(failure).toMatchObject({ kind: 'unreachable', code: 'ECONNREFUSED' });
    expect(failure!.message).toContain('127.0.0.1:5432/novelforge');
    expect(failure!.hint).toMatch(/file:\.\/prisma\/dev\.db/);
    expect(JSON.stringify(failure)).not.toContain('hunter2');
    expect(JSON.stringify(failure)).not.toContain('writer:');
  });

  it('maps PostgreSQL SQLSTATE codes to actionable kinds', () => {
    expect(classifyDatabaseError(pgError('28P01'))!.kind).toBe('authentication');
    expect(classifyDatabaseError(pgError('3D000'))!.kind).toBe('missing_database');
    expect(classifyDatabaseError(pgError('42501'))!.kind).toBe('permission');
    expect(classifyDatabaseError(pgError('53300'))!.kind).toBe('connections');
    expect(classifyDatabaseError(pgError('08006'))!.kind).toBe('unreachable');

    const missing = classifyDatabaseError(pgError('42P01', 'relation "users" does not exist'))!;
    expect(missing.kind).toBe('missing_schema');
    expect(missing.hint).toContain('npm run db:migrate');
  });

  it('distinguishes TLS failures and DNS failures', () => {
    expect(classifyDatabaseError(pgError('DEPTH_ZERO_SELF_SIGNED_CERT'))!.kind).toBe('ssl');
    expect(classifyDatabaseError(pgError('ENOTFOUND'))!.kind).toBe('unreachable');
    expect(classifyDatabaseError(pgError('ETIMEDOUT'))!.kind).toBe('timeout');
  });

  it('treats NovelForge configuration guards as configuration problems', () => {
    const productionSqlite = Object.assign(
      new Error('Production requires a PostgreSQL DATABASE_URL (postgresql://...). SQLite fallback is disabled in production unless ALLOW_SQLITE_IN_PRODUCTION=true is explicitly set.'),
      { name: 'DatabaseConfigurationError' },
    );
    expect(classifyDatabaseError(productionSqlite)!.kind).toBe('configuration');
    expect(classifyDatabaseError(new Error('Malformed PostgreSQL DATABASE_URL.'))!.kind).toBe('configuration');
    expect(classifyDatabaseError(new Error('AUTH_SECRET is required in production.')).message).toMatch(/AUTH_SECRET/);
  });

  it('leaves unrelated errors to the generic handler', () => {
    expect(classifyDatabaseError(new Error('boom'))).toBeNull();
    expect(classifyDatabaseError(undefined)).toBeNull();
  });

  it('reports the SQLite path and null for unconfigured databases', () => {
    process.env.DATABASE_URL = 'file:./prisma/dev.db';
    expect(databaseTarget()).toBe('./prisma/dev.db');
    process.env.DATABASE_URL = '';
    expect(databaseTarget()).toBeNull();
  });
});

describe('API error boundary', () => {
  it('answers 503 with a code and hint instead of an opaque 500', async () => {
    process.env.DATABASE_URL = 'postgresql://writer:hunter2@db.example.com:5432/novelforge';
    const res = errorResponse(pgError('28P01', 'password authentication failed for user "writer"'));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('database_authentication');
    expect(body.error).toMatch(/rejected the credentials/);
    expect(body.hint).toBeTruthy();

    const text = JSON.stringify(body);
    expect(text).not.toContain('hunter2');
    // The driver's raw message is logged, never returned.
    expect(text).not.toContain('password authentication failed');
  });

  it('still returns a generic 500 for genuine code faults', async () => {
    const res = errorResponse(new Error('undefined is not a function'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('POST /api/auth/register when the database is unusable', () => {
  const registerRequest = () =>
    new Request('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }),
    });

  it('returns 503 database_configuration rather than an opaque 500', async () => {
    process.env.DATABASE_URL = 'mysql://root:s3cret@localhost:3306/novelforge';
    resetDbForTests();

    const res = await register(registerRequest());
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.code).toBe('database_configuration');
    expect(body.hint).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('s3cret');
  });
});

describe('credential redaction in diagnostics', () => {
  it('never exposes userinfo from any connection URL', () => {
    process.env.DATABASE_URL = 'mysql://root:s3cret@db.internal:3306/novelforge';
    const target = databaseTarget();
    expect(target).toBe('db.internal:3306/novelforge');
    expect(target).not.toContain('s3cret');
  });
});
