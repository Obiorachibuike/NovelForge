import 'server-only';
import { createHash } from 'node:crypto';
import { assertSafeStoragePath, contentTypeFor, type StorageDriver, type StoredFile } from './types';

/**
 * Cloudinary driver (image CDN).
 *
 * Only covers should use this provider — DOCX/EPUB exports need object storage
 * (Cloudinary's raw-upload pipeline is deliberately not assumed here). The
 * driver uploads with a signed request and returns Cloudinary's HTTPS URL, so
 * images keep working after a redeploy.
 *
 * Configuration: CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET,
 * or a single CLOUDINARY_URL=cloudinary://<key>:<secret>@<cloud>.
 */
export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
}

export function readCloudinaryConfig(): CloudinaryConfig {
  const url = process.env.CLOUDINARY_URL;
  if (url) {
    const match = url.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
    if (match) {
      return { cloudName: match[3], apiKey: match[1], apiSecret: decodeURIComponent(match[2]), folder: process.env.CLOUDINARY_FOLDER || 'novelforge' };
    }
  }
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary storage is selected but CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET are not set. See docs/storage.md.');
  }
  return { cloudName, apiKey, apiSecret, folder: process.env.CLOUDINARY_FOLDER || 'novelforge' };
}

function sign(params: Record<string, string>, apiSecret: string): string {
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return createHash('sha1').update(`${toSign}${apiSecret}`).digest('hex');
}

export function cloudinaryDriver(config = readCloudinaryConfig()): StorageDriver {
  return {
    name: 'cloudinary',
    persistent: true,

    async put({ data, folder, ext }): Promise<StoredFile> {
      assertSafeStoragePath(folder, ext);
      if (!['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(ext.toLowerCase())) {
        throw new Error('Cloudinary storage supports images only. Use STORAGE_PROVIDER=s3 for manuscript exports.');
      }
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const publicId = `${config.folder}/${folder}/${Date.now().toString(36)}`;
      const signedParams = { folder: `${config.folder}/${folder}`, public_id: publicId, timestamp };
      const signature = sign(signedParams, config.apiSecret);

      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(data)], { type: contentTypeFor(ext) }), `${publicId}.${ext}`);
      form.append('api_key', config.apiKey);
      form.append('timestamp', timestamp);
      form.append('folder', signedParams.folder);
      form.append('public_id', publicId);
      form.append('signature', signature);

      const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Cloudinary upload failed (${res.status}). ${detail.slice(0, 200)}`);
      }
      const json = await res.json() as { secure_url?: string; public_id?: string; bytes?: number };
      if (!json.secure_url) throw new Error('Cloudinary upload returned no secure_url.');
      return {
        key: json.public_id || publicId,
        url: json.secure_url,
        size: json.bytes ?? data.length,
        contentType: contentTypeFor(ext),
      };
    },

    async get(key: string) {
      // Cloudinary URLs are absolute; the key alone is not enough to fetch, so
      // resolve through the public delivery URL.
      const url = key.startsWith('http') ? key : `https://res.cloudinary.com/${config.cloudName}/image/upload/${key}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'application/octet-stream' };
    },

    async delete(key: string) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = sign({ public_id: key, timestamp }, config.apiSecret);
      const form = new FormData();
      form.append('public_id', key);
      form.append('api_key', config.apiKey);
      form.append('timestamp', timestamp);
      form.append('signature', signature);
      await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/destroy`, { method: 'POST', body: form });
    },
  };
}
