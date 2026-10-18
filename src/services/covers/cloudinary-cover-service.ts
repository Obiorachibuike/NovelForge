import 'server-only';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { getDb } from '@/lib/db';
import { HttpError, redactSecrets } from '@/lib/api/http';

export const MAX_COVER_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface CloudinaryCoverConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  baseFolder: string;
  timeoutMs: number;
}

export interface ValidatedCoverImage {
  format: 'png' | 'jpg' | 'webp' | 'svg';
  contentType: string;
  bytes: number;
  width?: number;
  height?: number;
}

export interface CloudinaryUploadResult {
  publicId: string;
  secureUrl: string;
  format: string;
  bytes: number;
  width?: number;
  height?: number;
  folder: string;
  uploadedAt: string;
}

export interface SafeCoverMetadata {
  id: string;
  novelId: string;
  url: string;
  secureUrl: string | null;
  publicId: string | null;
  provider: string;
  format: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  isPrimary: boolean;
  uploadedAt: string | null;
  createdAt: string;
}

/**
 * Returns true when Cloudinary credentials are configured in the environment.
 */
export function isCloudinaryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLOUDINARY_URL && /^cloudinary:\/\/[^:]+:[^@]+@.+/.test(env.CLOUDINARY_URL)) {
    return true;
  }
  return Boolean(
    env.CLOUDINARY_CLOUD_NAME?.trim() &&
      env.CLOUDINARY_API_KEY?.trim() &&
      env.CLOUDINARY_API_SECRET?.trim(),
  );
}

/**
 * Reads and validates server-side Cloudinary credentials.
 * Never logs or includes `apiSecret` in error messages.
 */
export function getCloudinaryCoverConfig(env: NodeJS.ProcessEnv = process.env): CloudinaryCoverConfig {
  const timeoutRaw = Number(env.CLOUDINARY_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw >= 1000 ? Math.floor(timeoutRaw) : 30_000;
  const baseFolder = (env.CLOUDINARY_FOLDER || 'novelforge').replace(/^\/+|\/+$/g, '') || 'novelforge';

  if (env.CLOUDINARY_URL) {
    const match = env.CLOUDINARY_URL.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
    if (match) {
      return {
        cloudName: match[3].trim(),
        apiKey: match[1].trim(),
        apiSecret: decodeURIComponent(match[2].trim()),
        baseFolder,
        timeoutMs,
      };
    }
  }

  const cloudName = env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = env.CLOUDINARY_API_SECRET?.trim();

  if (!cloudName || !apiKey || !apiSecret) {
    throw new HttpError(
      503,
      'Cloudinary cover storage is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET on the server.',
      'cloudinary_not_configured',
    );
  }

  return { cloudName, apiKey, apiSecret, baseFolder, timeoutMs };
}

function sanitizeSegment(id: string, label: string): string {
  const trimmed = (id || '').trim();
  if (!trimmed || !/^[A-Za-z0-9_-]{1,80}$/.test(trimmed)) {
    throw new HttpError(400, `Invalid ${label} identifier.`, 'invalid_identifier');
  }
  return trimmed;
}

/**
 * Builds the predictable user-and-novel-scoped Cloudinary folder:
 *   `<baseFolder>/covers/<userId>/<novelId>`
 */
export function buildCoverFolder(userId: string, novelId: string, baseFolder = 'novelforge'): string {
  const u = sanitizeSegment(userId, 'user');
  const n = sanitizeSegment(novelId, 'novel');
  const base = baseFolder.replace(/^\/+|\/+$/g, '') || 'novelforge';
  return `${base}/covers/${u}/${n}`;
}

/**
 * Builds a deterministic, collision-free Cloudinary public_id for a novel cover:
 *   `<baseFolder>/covers/<userId>/<novelId>/cover_<imageId>`
 */
export function buildCoverPublicId(
  userId: string,
  novelId: string,
  imageId: string,
  baseFolder = 'novelforge',
): string {
  const folder = buildCoverFolder(userId, novelId, baseFolder);
  const img = sanitizeSegment(imageId, 'image');
  return `${folder}/cover_${img}`;
}

/**
 * Computes Cloudinary's SHA-1 parameter signature on the server.
 */
export function signCloudinaryParams(params: Record<string, string>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== '')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(`${toSign}${apiSecret}`).digest('hex');
}

/**
 * Validates actual image binary/XML content rather than trusting file extension
 * or declared MIME type. Enforces size bounds and inspects magic bytes.
 */
export function validateCoverImageBuffer(buffer: Buffer): ValidatedCoverImage {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HttpError(400, 'Cover image payload is empty.', 'invalid_cover_image');
  }
  if (buffer.length > MAX_COVER_IMAGE_BYTES) {
    throw new HttpError(
      413,
      `Cover image exceeds maximum allowed size (${Math.round(MAX_COVER_IMAGE_BYTES / (1024 * 1024))} MB).`,
      'cover_too_large',
    );
  }

  // 1. PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return {
      format: 'png',
      contentType: 'image/png',
      bytes: buffer.length,
      ...(width > 0 && height > 0 ? { width, height } : {}),
    };
  }

  // 2. JPEG signature: FF D8 FF
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return {
      format: 'jpg',
      contentType: 'image/jpeg',
      bytes: buffer.length,
    };
  }

  // 3. WebP signature: "RIFF" .... "WEBP"
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return {
      format: 'webp',
      contentType: 'image/webp',
      bytes: buffer.length,
    };
  }

  // 4. SVG XML content inspection (rejects embedded scripts or event handlers)
  const head = buffer.subarray(0, Math.min(buffer.length, 64 * 1024)).toString('utf8').trim();
  if ((head.startsWith('<?xml') || head.startsWith('<svg')) && /<svg[\s>]/i.test(head) && /<\/svg>/i.test(head)) {
    if (/<script[\s>]/i.test(head) || /\bon[a-z]+\s*=/i.test(head)) {
      throw new HttpError(
        400,
        'SVG cover contains disallowed active script content.',
        'invalid_cover_image',
      );
    }
    return {
      format: 'svg',
      contentType: 'image/svg+xml',
      bytes: buffer.length,
    };
  }

  throw new HttpError(
    400,
    'Unsupported or corrupted cover image content. Allowed formats: PNG, JPEG, WebP, SVG.',
    'invalid_cover_image',
  );
}

/**
 * Stores a temporary/candidate cover preview locally so candidate generation
 * does not upload every unselected variation to Cloudinary.
 */
export async function saveCandidateCoverPreview(input: {
  data: Buffer;
  ext?: string;
}): Promise<{ key: string; url: string; validated: ValidatedCoverImage }> {
  const validated = validateCoverImageBuffer(input.data);
  const ext = validated.format;
  const filename = `${Date.now()}-${nanoid(8)}.${ext}`;
  const key = `covers/${filename}`;

  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : process.env.VERCEL
      ? path.join(os.tmpdir(), 'novelforge-data')
      : path.join(process.cwd(), '.data');

  const fullPath = path.join(dataDir, 'uploads', key);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, input.data);

  return {
    key,
    url: `/api/files/${key}`,
    validated,
  };
}

/**
 * Reads a candidate cover preview buffer from local/temporary candidate storage
 * or the configured storage driver.
 */
export async function readCandidateCoverBytes(storageKey: string): Promise<Buffer | null> {
  if (!storageKey || storageKey.includes('..')) return null;

  const candidateDirs = [
    process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null,
    path.join(process.cwd(), '.data'),
    path.join(os.tmpdir(), 'novelforge-data'),
  ].filter(Boolean) as string[];

  for (const base of candidateDirs) {
    const p = path.join(base, 'uploads', storageKey);
    if (fs.existsSync(p)) {
      return fs.promises.readFile(p);
    }
  }

  const { readFile } = await import('@/lib/storage');
  const stored = await readFile(storageKey).catch(() => null);
  return stored ? stored.data : null;
}

/**
 * Uploads a validated cover image buffer to Cloudinary under
 * `novelforge/covers/<userId>/<novelId>/cover_<imageId>`.
 */
export async function uploadCoverToCloudinary(input: {
  userId: string;
  novelId: string;
  imageId: string;
  data: Buffer;
  config?: CloudinaryCoverConfig;
}): Promise<CloudinaryUploadResult> {
  const config = input.config || getCloudinaryCoverConfig();
  const validated = validateCoverImageBuffer(input.data);
  const folder = buildCoverFolder(input.userId, input.novelId, config.baseFolder);
  const leafPublicId = `cover_${sanitizeSegment(input.imageId, 'image')}`;
  const fullPublicId = `${folder}/${leafPublicId}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const signedParams: Record<string, string> = {
    folder,
    overwrite: 'true',
    public_id: leafPublicId,
    timestamp,
  };
  const signature = signCloudinaryParams(signedParams, config.apiSecret);

  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(input.data)], { type: validated.contentType }),
    `${leafPublicId}.${validated.format}`,
  );
  form.append('api_key', config.apiKey);
  form.append('timestamp', timestamp);
  form.append('folder', folder);
  form.append('public_id', leafPublicId);
  form.append('overwrite', 'true');
  form.append('signature', signature);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let res: Response;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new HttpError(
        504,
        'Cloudinary cover upload timed out. Please retry selecting the cover.',
        'cloudinary_timeout',
      );
    }
    throw new HttpError(
      502,
      'Could not reach Cloudinary to upload the selected cover. Please retry.',
      'cloudinary_network_error',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const rawDetail = await res.text().catch(() => '');
    console.error('[cloudinary] upload failed:', res.status, redactSecrets(rawDetail.slice(0, 200)));
    throw new HttpError(
      502,
      `Cloudinary rejected the cover upload (HTTP ${res.status}). Please retry.`,
      'cloudinary_upload_failed',
    );
  }

  const payload = (await res.json().catch(() => null)) as {
    secure_url?: string;
    public_id?: string;
    format?: string;
    bytes?: number;
    width?: number;
    height?: number;
  } | null;

  if (!payload?.secure_url || !payload.secure_url.startsWith('https://')) {
    throw new HttpError(
      502,
      'Cloudinary upload response did not include a valid HTTPS secure_url.',
      'cloudinary_invalid_response',
    );
  }

  return {
    publicId: payload.public_id || fullPublicId,
    secureUrl: payload.secure_url,
    format: payload.format || validated.format,
    bytes: payload.bytes ?? validated.bytes,
    width: payload.width ?? validated.width,
    height: payload.height ?? validated.height,
    folder,
    uploadedAt: new Date().toISOString(),
  };
}

/**
 * Deletes a Cloudinary cover asset after verifying that its `publicId` is
 * scoped to the caller's `(userId, novelId)` folder so one user can never
 * delete another user's Cloudinary asset.
 */
export async function deleteCloudinaryCover(
  publicId: string,
  ownership: { userId: string; novelId: string },
  config?: CloudinaryCoverConfig,
): Promise<boolean> {
  if (!publicId) return false;
  const resolvedConfig = config || getCloudinaryCoverConfig();
  const expectedPrefix = `${buildCoverFolder(ownership.userId, ownership.novelId, resolvedConfig.baseFolder)}/`;
  if (!publicId.startsWith(expectedPrefix)) {
    throw new HttpError(
      403,
      'Refusing to delete a Cloudinary cover outside the novel owner namespace.',
      'cloudinary_Cross_user_delete_denied',
    );
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signCloudinaryParams({ invalidate: 'true', public_id: publicId, timestamp }, resolvedConfig.apiSecret);

  const form = new FormData();
  form.append('public_id', publicId);
  form.append('api_key', resolvedConfig.apiKey);
  form.append('timestamp', timestamp);
  form.append('invalidate', 'true');
  form.append('signature', signature);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolvedConfig.timeoutMs);
  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${resolvedConfig.cloudName}/image/destroy`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function serializeSafeCoverMetadata(row: Record<string, any>): SafeCoverMetadata {
  return {
    id: row.id,
    novelId: row.novelId,
    url: row.secureUrl || row.url,
    secureUrl: row.secureUrl || (typeof row.url === 'string' && row.url.startsWith('https://res.cloudinary.com/') ? row.url : null),
    publicId: row.publicId || null,
    provider: row.provider,
    format: row.format || null,
    bytes: row.bytes ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    isPrimary: Boolean(row.isPrimary),
    uploadedAt: row.uploadedAt || null,
    createdAt: row.createdAt,
  };
}
