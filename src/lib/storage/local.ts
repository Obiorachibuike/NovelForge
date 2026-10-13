import { mkdir, writeFile, readFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { contentTypeFor, type StorageDriver, type StoredFile } from './types';

/**
 * Local disk driver.
 *
 * Files live in `DATA_DIR/uploads/<key>` (default `.data/uploads`, outside
 * `public/`) and are served through the authenticated `/api/files/<key>` route,
 * so neither covers nor exports are world-readable. Files written by earlier
 * versions into `public/uploads` are moved here on first use and their URLs are
 * rewritten (see `migrateLegacyUploads`).
 */
export function dataRoot(): string {
  const configured = process.env.DATA_DIR || process.env.LOCAL_STORAGE_DIR;
  if (configured) return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  return path.join(process.cwd(), '.data');
}

export function localUploadsDir(): string {
  return path.join(dataRoot(), 'uploads');
}

/** Legacy location used before this driver existed. */
export function legacyUploadsDir(): string {
  return path.join(process.cwd(), 'public', 'uploads');
}

export function assertLocalStorageAllowed() {
  if (process.env.VERCEL) {
    throw new Error(
      'Local disk storage is not persistent on Vercel. Configure persistent object storage ' +
        '(STORAGE_PROVIDER=s3 with S3_BUCKET/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY, ' +
        'or STORAGE_PROVIDER=cloudinary) before generating covers or exports. See docs/storage.md.',
    );
  }
}

export const localDriver: StorageDriver = {
  name: 'local',
  persistent: !process.env.VERCEL,

  async put({ data, folder, ext }): Promise<StoredFile> {
    assertLocalStorageAllowed();
    const key = `${folder}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const target = path.join(localUploadsDir(), key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
    return { key, url: `/api/files/${key}`, size: data.length, contentType: contentTypeFor(ext) };
  },

  async get(key: string) {
    const safe = key.replace(/\.\./g, '');
    for (const candidate of [path.join(localUploadsDir(), safe), path.join(legacyUploadsDir(), safe)]) {
      try {
        const data = await readFile(candidate);
        return { data, contentType: contentTypeFor(path.extname(candidate).slice(1)) };
      } catch {
        continue;
      }
    }
    return null;
  },

  async delete(key: string) {
    const safe = key.replace(/\.\./g, '');
    for (const candidate of [path.join(localUploadsDir(), safe), path.join(legacyUploadsDir(), safe)]) {
      try {
        const { unlink } = await import('node:fs/promises');
        await unlink(candidate);
      } catch {
        continue;
      }
    }
  },
};

let _migrated = false;

/**
 * Moves `public/uploads/**` into the private data directory and points the
 * database rows at the authenticated file route. Idempotent and safe to call
 * from any request path; failures are logged, never fatal.
 */
export async function migrateLegacyUploads(): Promise<{ moved: number }> {
  if (_migrated) return { moved: 0 };
  _migrated = true;
  let moved = 0;
  try {
    const legacy = legacyUploadsDir();
    try { await access(legacy); } catch { return { moved: 0 }; }

    const { readdir } = await import('node:fs/promises');
    for (const folder of await readdir(legacy, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      const source = path.join(legacy, folder.name);
      const target = path.join(localUploadsDir(), folder.name);
      await mkdir(target, { recursive: true });
      for (const file of await readdir(source, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        const from = path.join(source, file.name);
        const to = path.join(target, file.name);
        try {
          await rename(from, to);
        } catch {
          continue;
        }
        moved++;
        const key = `${folder.name}/${file.name}`;
        try {
          const { getDb } = await import('@/lib/db');
          const db = getDb();
          db.prepare('UPDATE image_assets SET url=? WHERE storageKey=? AND url LIKE ?').run(`/api/files/${key}`, key, '/uploads/%');
          db.prepare('UPDATE exports SET fileUrl=? WHERE fileKey=? AND fileUrl LIKE ?').run(`/api/files/${key}`, key, '/uploads/%');
        } catch (err) {
          console.warn('[storage] could not rewrite legacy url for', key, err);
        }
      }
    }
    if (moved) console.log(`[storage] moved ${moved} legacy upload(s) out of public/`);
  } catch (err) {
    console.warn('[storage] legacy upload migration failed:', err);
  }
  return { moved };
}
