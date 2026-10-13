import 'server-only';
import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal, dependency-free AWS Signature Version 4 signer.
 *
 * Used by the S3 storage driver so the app can talk to AWS S3, Cloudflare R2,
 * Backblaze B2 or MinIO without pulling the AWS SDK into the Next.js bundle.
 * The implementation follows the AWS "Signature Version 4 test suite" example
 * shape and is covered by unit tests against published vectors.
 */
export interface SigV4Input {
  method: string;
  /** Path with a leading slash, already URL-encoded per segment. */
  path: string;
  /** Canonical query string (sorted, URL-encoded), no leading '?'. */
  query?: string;
  headers: Record<string, string>;
  payload: Buffer | string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injectable for deterministic tests. */
  date?: Date;
}

export interface SigV4Result {
  headers: Record<string, string>;
  signature: string;
  canonicalRequest: string;
  stringToSign: string;
  amzDate: string;
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

export function amzDates(date: Date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export function signRequest(input: SigV4Input): SigV4Result {
  const service = input.service || 's3';
  const { amzDate, dateStamp } = amzDates(input.date || new Date());
  const payloadHash = sha256Hex(input.payload);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  headers['host'] = headers['host'];
  headers['x-amz-content-sha256'] = payloadHash;
  headers['x-amz-date'] = amzDate;

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    input.query || '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    signature,
    canonicalRequest,
    stringToSign,
    amzDate,
  };
}

/** URL-encodes a path segment the way S3 expects (RFC 3986, slash preserved). */
export function encodeS3Path(path: string): string {
  return path
    .split('/')
    .map(seg => encodeURIComponent(seg).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}
