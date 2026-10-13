import 'server-only';
import { assertSafeStoragePath, contentTypeFor, type StorageDriver, type StoredFile } from './types';
import { localDriver, migrateLegacyUploads } from './local';

export type { StorageDriver, StoredFile } from './types';
export { contentTypeFor } from './types';

export type StorageProviderName = 'local' | 's3' | 'cloudinary';

export function storageProviderName(): StorageProviderName {
  const raw = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
  if (raw === 's3' || raw === 'cloudinary' || raw === 'local') return raw;
  // Legacy/ambiguous values must fail loudly rather than silently storing to disk.
  throw new Error(`Unknown STORAGE_PROVIDER "${raw}". Use "local", "s3" or "cloudinary".`);
}

let _driver: StorageDriver | null = null;

export async function getStorageDriver(): Promise<StorageDriver> {
  if (_driver) return _driver;
  switch (storageProviderName()) {
    case 's3': {
      const { s3Driver } = await import('./s3');
      _driver = s3Driver();
      break;
    }
    case 'cloudinary': {
      const { cloudinaryDriver } = await import('./cloudinary');
      _driver = cloudinaryDriver();
      break;
    }
    default:
      _driver = localDriver;
  }
  return _driver;
}

/** Test seam: forces a driver (or resets to configuration-derived selection). */
export function __setStorageDriverForTests(driver: StorageDriver | null) {
  _driver = driver;
}

export interface SaveFileInput {
  data: Buffer;
  folder: string;
  ext: string;
  contentType?: string;
}

/** Saves a buffer and returns its key plus the URL clients should use. */
export async function saveFile(input: SaveFileInput): Promise<StoredFile> {
  assertSafeStoragePath(input.folder, input.ext);
  const driver = await getStorageDriver();
  if (driver.name === 'local') await migrateLegacyUploads();
  const stored = await driver.put(input);
  return { ...stored, contentType: input.contentType || stored.contentType || contentTypeFor(input.ext) };
}

/** Reads a stored object (used by the authenticated download route). */
export async function readFile(key: string): Promise<{ data: Buffer; contentType: string } | null> {
  if (!key || key.includes('..')) return null;
  const driver = await getStorageDriver();
  if (driver.name === 'local') await migrateLegacyUploads();
  return driver.get(key);
}

export async function deleteFile(key: string): Promise<void> {
  const driver = await getStorageDriver();
  await driver.delete(key);
}

/** True when generated files survive a redeploy in the current configuration. */
export async function storageIsPersistent(): Promise<boolean> {
  try {
    return (await getStorageDriver()).persistent;
  } catch {
    return false;
  }
}

export async function storageInfo() {
  try {
    const provider = storageProviderName();
    const persistent = await storageIsPersistent();
    return {
      provider,
      persistent,
      protected: provider !== 'cloudinary',
      note: provider === 'local'
        ? 'Files are written to the DATA_DIR volume and served through the authenticated /api/files route.'
        : provider === 's3'
          ? 'Objects are stored in the configured bucket and proxied through /api/files (or a CDN base URL).'
          : 'Images are hosted on Cloudinary; manuscript exports require STORAGE_PROVIDER=s3 or local disk.',
    };
  } catch (err) {
    return { provider: 'misconfigured', persistent: false, protected: false, note: err instanceof Error ? err.message : String(err) };
  }
}
