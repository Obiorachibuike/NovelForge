import 'server-only';
import { ZodError } from 'zod';

/**
 * Thrown by guards/helpers to produce a specific HTTP status. Messages on
 * 4xx responses are safe to show to the caller; 5xx messages are replaced with
 * a generic string before leaving the server (see `errorResponse`).
 */
export class HttpError extends Error {
  status: number;
  /** Optional machine-readable code for clients. */
  code?: string;
  /** Optional structured payload (e.g. the entitlement state behind a 402). */
  details?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError || (!!err && typeof err === 'object' && 'status' in err && typeof (err as HttpError).status === 'number' && (err as HttpError).status >= 400 && (err as HttpError).status < 600);
}

/**
 * Converts any thrown value into a JSON `Response`.
 *
 * Only deliberately-thrown `HttpError`s (and validation failures, which routes
 * convert to 400) surface their message. Everything else is logged server-side
 * and answered with a generic 500 so SQL text, file paths and upstream provider
 * errors never reach the client.
 */
export function errorResponse(err: unknown): Response {
  // Next.js signals "this route is dynamic" with an internal error. It must be
  // rethrown so the framework can handle it, not swallowed into a 500.
  const digest = (err as any)?.digest;
  if (typeof digest === 'string' && (digest === 'DYNAMIC_SERVER_USAGE' || digest.startsWith('NEXT_'))) {
    throw err;
  }
  if (err instanceof ZodError) {
    // Validation failures are the caller's fault: report them as 400 with the
    // first concrete message, never as an opaque 500.
    const first = err.errors[0];
    const path = first?.path?.join('.');
    return Response.json(
      { error: first ? `${path ? `${path}: ` : ''}${first.message}` : 'Invalid request body', code: 'validation_failed' },
      { status: 400 },
    );
  }
  if (isHttpError(err)) {
    return Response.json(
      { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.details ?? {}) },
      { status: err.status },
    );
  }
  console.error('[api] unhandled error:', err);
  return Response.json({ error: 'Internal server error' }, { status: 500 });
}

/**
 * Wraps a route handler so thrown `HttpError`s/validation errors become clean
 * JSON responses instead of framework 500s.
 */
export function apiHandler<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response> | Response,
): (...args: Args) => Promise<Response> {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export const MAX_JSON_BYTES = {
  /** Small control payloads: AI editor actions, job enqueues, settings, selections. */
  default: 64 * 1024,
  /** Chapter autosave: a full Tiptap document in JSON. */
  document: 2 * 1024 * 1024,
  /** Export options / cover prompts. */
  export: 64 * 1024,
};

/**
 * Reads and validates a JSON request body with an explicit size ceiling.
 *
 * Next.js does not apply `serverActions.bodySizeLimit` to Route Handlers, so
 * every handler must enforce its own limit; otherwise a single client can write
 * arbitrarily large documents into the database.
 */
export async function readJsonBody<T>(
  req: Request,
  parse: (value: unknown) => T,
  maxBytes: number = MAX_JSON_BYTES.default,
): Promise<T> {
  const declared = Number(req.headers.get('content-length') || '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `Request body too large (limit ${Math.round(maxBytes / 1024)} KB).`, 'payload_too_large');
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new HttpError(400, 'Could not read request body.');
  }
  if (text.length > maxBytes) {
    throw new HttpError(413, `Request body too large (limit ${Math.round(maxBytes / 1024)} KB).`, 'payload_too_large');
  }
  let json: unknown = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Request body must be valid JSON.');
    }
  }
  return parse(json);
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export function redirectResponse(location: string, status = 303): Response {
  return new Response(null, { status, headers: { Location: location } });
}
