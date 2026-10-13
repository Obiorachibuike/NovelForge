import 'server-only';
import { assertSafeStoragePath, contentTypeFor, type StorageDriver, type StoredFile } from './types';
import { encodeS3Path, signRequest } from './s3-signature';

/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO…).
 *
 * Objects are private by default: `/api/files/<key>` proxies them through the
 * application after an ownership check. If the bucket is fronted by a CDN set
 * `S3_PUBLIC_BASE_URL` and stored URLs point straight at it instead.
 *
 * Required configuration: S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.
 * Optional: S3_ENDPOINT (non-AWS providers), S3_FORCE_PATH_STYLE=true, S3_PREFIX,
 * S3_PUBLIC_BASE_URL.
 */
export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  forcePathStyle: boolean;
  prefix: string;
  publicBaseUrl?: string;
}

export function readS3Config(): S3Config {
  const missing = ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`S3 storage is selected but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set. See docs/storage.md.`);
  }
  return {
    bucket: process.env.S3_BUCKET!,
    region: process.env.S3_REGION!,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    endpoint: process.env.S3_ENDPOINT?.replace(/\/+$/, ''),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    prefix: (process.env.S3_PREFIX || '').replace(/^\/+|\/+$/g, ''),
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL?.replace(/\/+$/, ''),
  };
}

function objectKey(config: S3Config, key: string): string {
  return config.prefix ? `${config.prefix}/${key}` : key;
}

function requestTarget(config: S3Config, key: string): { url: string; host: string; path: string } {
  const fullKey = objectKey(config, key);
  if (config.endpoint) {
    const url = new URL(config.endpoint);
    const base = config.forcePathStyle ? `/${config.bucket}/${fullKey}` : `/${fullKey}`;
    return {
      url: `${url.origin}${encodeS3Path(base)}`,
      host: url.host,
      path: encodeS3Path(base),
    };
  }
  const host = `${config.bucket}.s3.${config.region}.amazonaws.com`;
  const path = `/${fullKey}`;
  return { url: `https://${host}${encodeS3Path(path)}`, host, path: encodeS3Path(path) };
}

export function s3Driver(config = readS3Config()): StorageDriver {
  return {
    name: 's3',
    persistent: true,

    async put({ data, folder, ext }): Promise<StoredFile> {
      assertSafeStoragePath(folder, ext);
      const key = `${folder}/${Date.now().toString(36)}-${randomSuffix()}.${ext}`;
      const contentType = contentTypeFor(ext);
      const target = requestTarget(config, key);
      const signed = signRequest({
        method: 'PUT',
        path: target.path,
        headers: { host: target.host, 'content-type': contentType },
        payload: data,
        region: config.region,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      });

      const res = await fetch(target.url, {
        method: 'PUT',
        headers: {
          'content-type': contentType,
          'x-amz-content-sha256': signed.headers['x-amz-content-sha256'],
          'x-amz-date': signed.headers['x-amz-date'],
          authorization: signed.headers.authorization,
        },
        body: new Uint8Array(data),
      });
      if (!res.ok) {
        throw new Error(`S3 upload failed (${res.status} ${res.statusText}). Check bucket permissions and credentials.`);
      }
      const url = config.publicBaseUrl ? `${config.publicBaseUrl}/${objectKey(config, key)}` : `/api/files/${key}`;
      return { key, url, size: data.length, contentType };
    },

    async get(key: string) {
      const target = requestTarget(config, key);
      const signed = signRequest({
        method: 'GET',
        path: target.path,
        headers: { host: target.host },
        payload: '',
        region: config.region,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      });
      const res = await fetch(target.url, {
        headers: {
          'x-amz-content-sha256': signed.headers['x-amz-content-sha256'],
          'x-amz-date': signed.headers['x-amz-date'],
          authorization: signed.headers.authorization,
        },
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return { data: buf, contentType: res.headers.get('content-type') || contentTypeFor(key.split('.').pop() || '') };
    },

    async delete(key: string) {
      const target = requestTarget(config, key);
      const signed = signRequest({
        method: 'DELETE',
        path: target.path,
        headers: { host: target.host },
        payload: '',
        region: config.region,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      });
      await fetch(target.url, {
        method: 'DELETE',
        headers: {
          'x-amz-content-sha256': signed.headers['x-amz-content-sha256'],
          'x-amz-date': signed.headers['x-amz-date'],
          authorization: signed.headers.authorization,
        },
      });
    },
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
