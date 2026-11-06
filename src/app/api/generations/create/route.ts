import 'server-only';

/**
 * POST /api/generations/create — deprecated alias.
 *
 * This path was a second, diverging copy of the universal creation handler.
 * There is one implementation (`/api/generations/universal`) so validation,
 * ownership checks, rate limiting and the response contract cannot drift; this
 * module only re-exports it for existing clients.
 */
export { POST } from '../universal/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
