/**
 * Database failure diagnosis.
 *
 * Every auth/page/API request in NovelForge eventually touches the database, so a
 * misconfigured or unreachable `DATABASE_URL` used to surface as a bare
 * `500 {"error":"Internal server error"}` on `/api/auth/register` and as an
 * Auth.js `Configuration` error on `/login` — with no hint about what to fix.
 *
 * This module maps the driver/network errors that actually occur (bad config,
 * ECONNREFUSED, bad credentials, missing schema, TLS problems, ...) onto a
 * short, **secret-free** explanation plus a concrete remediation hint. It is
 * used by the API error boundary (503 instead of 500) and by `/api/health`.
 *
 * Nothing here may include a password, token or the raw connection string:
 * `DATABASE_URL` frequently embeds credentials.
 */

export type DatabaseFailureKind =
  | 'configuration'
  | 'unreachable'
  | 'timeout'
  | 'authentication'
  | 'missing_database'
  | 'missing_schema'
  | 'permission'
  | 'ssl'
  | 'connections'
  | 'starting_up'
  | 'unknown';

export interface DatabaseFailure {
  kind: DatabaseFailureKind;
  /** Driver/SQLSTATE code, when one was reported. */
  code: string | null;
  /** Safe to show to an operator or (for a self-hosted app) to the browser. */
  message: string;
  /** What to actually do about it. */
  hint: string;
  /** `host:port/database` — never user or password. Null if unparseable. */
  target: string | null;
}

/**
 * `host:port/database` for the configured database, with credentials stripped.
 * Used in messages and logs so "which database?" is answerable at a glance.
 */
export function databaseTarget(url: string | undefined = process.env.DATABASE_URL): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed.startsWith('file:')) {
    // SQLite: the path is the whole story.
    return trimmed.slice(5) || null;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // A bare path (SQLITE_PATH style) has no credentials to leak.
    return trimmed || null;
  }
  try {
    // `URL` keeps the userinfo out of hostname/port, so a credential-bearing
    // DATABASE_URL (postgresql://user:pass@host/db, mysql://..., ...) can never
    // leak through a log line or error response.
    const parsed = new URL(trimmed);
    const port = parsed.port || (parsed.protocol.startsWith('postgres') ? '5432' : '');
    const db = parsed.pathname.replace(/^\//, '');
    return `${parsed.hostname}${port ? `:${port}` : ''}${db ? `/${db}` : ''}`;
  } catch {
    return null;
  }
}

const DEFAULT_HINT =
  'Verify DATABASE_URL in your environment. For local development, DATABASE_URL="file:./prisma/dev.db" needs no server; production requires a PostgreSQL URL. Inspect GET /api/health for the live diagnosis.';

function configuration(message: string, hint = DEFAULT_HINT): DatabaseFailure {
  return { kind: 'configuration', code: 'configuration', message, hint, target: databaseTarget() };
}

/**
 * Classifies a thrown value. Returns `null` when the error is not database
 * related, so callers can fall through to their generic handling.
 */
export function classifyDatabaseError(err: unknown): DatabaseFailure | null {
  if (!err) return null;

  const name = typeof err === 'object' && err !== null ? String((err as any).name || '') : '';
  const code = typeof err === 'object' && err !== null && (err as any).code != null
    ? String((err as any).code)
    : null;
  const rawMessage =
    typeof err === 'string' ? err : typeof (err as any)?.message === 'string' ? (err as any).message : '';
  const message = rawMessage || '';

  const target = databaseTarget();

  // ---- Our own configuration guards -------------------------------------
  if (name === 'DatabaseConfigurationError') {
    return configuration(message || 'The database is not configured correctly.', DEFAULT_HINT);
  }
  if (
    /^DATABASE_URL\b/.test(message) ||
    /^Invalid PostgreSQL connection string/.test(message) ||
    /^Malformed PostgreSQL DATABASE_URL/.test(message) ||
    /^PostgreSQL DATABASE_URL is missing/.test(message) ||
    /SQLite fallback is disabled in production/.test(message) ||
    /DATABASE_URL points at MySQL/.test(message)
  ) {
    return configuration(
      message,
      /MySQL/.test(message)
        ? 'NovelForge only supports PostgreSQL or SQLite. Point DATABASE_URL at a postgresql:// or file: URL.'
        : DEFAULT_HINT,
    );
  }
  if (/AUTH_SECRET/.test(message)) {
    return configuration(
      'The server is missing a valid AUTH_SECRET, so sign-in cannot be completed.',
      'Set AUTH_SECRET to a random value of at least 32 characters (openssl rand -base64 48) and restart the app.',
    );
  }

  // ---- TLS ---------------------------------------------------------------
  const tlsCodes = new Set([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
  ]);
  if (
    (code && tlsCodes.has(code)) ||
    /self[- ]signed certificate|unable to verify the first certificate|certificate has expired/i.test(message)
  ) {
    return {
      kind: 'ssl',
      code,
      message: `The database TLS certificate could not be verified${target ? ` (${target})` : ''}.`,
      hint: 'Managed providers (Neon, Supabase, RDS) usually need PG_SSL="no-verify" for their own CA, or the provider CA certificate installed. Never disable verification for an untrusted network.',
      target,
    };
  }

  // ---- Network / connectivity -------------------------------------------
  if (code === 'ECONNREFUSED') {
    return {
      kind: 'unreachable',
      code,
      message: `Nothing is accepting connections at the database address${target ? ` (${target})` : ''}.`,
      hint: 'Is PostgreSQL running and reachable from this machine? For local work start it (see docs/postgresql.md), or set DATABASE_URL="file:./prisma/dev.db" to use SQLite and restart.',
      target,
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      kind: 'unreachable',
      code,
      message: `The database hostname could not be resolved${target ? ` (${target})` : ''}.`,
      hint: 'Check the hostname in DATABASE_URL (and DNS/network egress from the deployment).',
      target,
    };
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return {
      kind: 'unreachable',
      code,
      message: `The database connection was dropped${target ? ` (${target})` : ''}.`,
      hint: 'Check provider status, connection limits, and whether the database requires SSL (PG_SSL).',
      target,
    };
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timed out after \d+\s*ms/i.test(message)) {
    return {
      kind: 'timeout',
      code,
      message: `The database did not answer in time${target ? ` (${target})` : ''}.`,
      hint: 'Check network access to the database and raise PG_CONNECTION_TIMEOUT_MS if the provider is slow to wake.',
      target,
    };
  }

  // ---- PostgreSQL SQLSTATE codes ----------------------------------------
  switch (code) {
    case '28P01':
    case '28000':
      return {
        kind: 'authentication',
        code,
        message: `The database rejected the credentials${target ? ` (${target})` : ''}.`,
        hint: 'Check the username/password in DATABASE_URL and that the role exists on that database.',
        target,
      };
    case '3D000':
      return {
        kind: 'missing_database',
        code,
        message: `The database named in DATABASE_URL does not exist${target ? ` (${target})` : ''}.`,
        hint: 'Create the database (e.g. `createdb novelforge`) or correct the database name in DATABASE_URL.',
        target,
      };
    case '42P01':
      return {
        kind: 'missing_schema',
        code,
        message: 'The database is reachable but its schema is missing (a required table does not exist).',
        hint: 'Apply the migrations with `npm run db:migrate` (they also run automatically on first connection — check the server logs if that failed).',
        target,
      };
    case '42501':
      return {
        kind: 'permission',
        code,
        message: 'The database user is not allowed to perform this operation.',
        hint: 'Grant the role ownership of the schema/database in DATABASE_URL (CREATE on the public schema is required by migrations).',
        target,
      };
    case '53300':
    case '53400':
      return {
        kind: 'connections',
        code,
        message: 'The database refused the connection because it has no capacity left.',
        hint: 'Lower PG_POOL_MAX, close idle connections, or raise the provider connection limit (serverless deployments need a pooler such as Neon/Supabase pooler or pgbouncer).',
        target,
      };
    case '57P03':
      return {
        kind: 'starting_up',
        code,
        message: 'The database is still starting up and cannot accept connections yet.',
        hint: 'Retry in a few seconds, or raise PG_CONNECTION_TIMEOUT_MS for cold-starting instances.',
        target,
      };
    case '08000':
    case '08003':
    case '08006':
    case '08001':
    case '08004':
      return {
        kind: 'unreachable',
        code,
        message: `The database connection could not be established${target ? ` (${target})` : ''}.`,
        hint: 'Check provider status and network access (including SSL requirements) from this deployment.',
        target,
      };
    default:
      break;
  }

  // ---- Messages without a code ------------------------------------------
  if (/does not exist|no such table/i.test(message) && /relation|table|novelforge/i.test(message)) {
    return {
      kind: 'missing_schema',
      code,
      message: 'The database is reachable but its schema is missing (a required table does not exist).',
      hint: 'Apply the migrations with `npm run db:migrate`.',
      target,
    };
  }

  return null;
}

/** Short one-line description for logs: `unreachable/ECONNREFUSED at host:5432/db`. */
export function describeDatabaseFailure(failure: DatabaseFailure): string {
  return `${failure.kind}${failure.code ? `/${failure.code}` : ''}${failure.target ? ` at ${failure.target}` : ''}`;
}
