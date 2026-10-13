import 'server-only';

export interface StoredFile {
  key: string;
  /** Application-relative URL; served through the ownership-checked /api/files route. */
  url: string;
  size: number;
  contentType: string;
}

export interface PutInput {
  data: Buffer;
  folder: string;
  ext: string;
  contentType?: string;
}

export interface StorageDriver {
  name: 'local' | 's3' | 'cloudinary';
  /** True when objects survive an application redeploy. */
  persistent: boolean;
  put(input: PutInput): Promise<StoredFile>;
  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json',
};

export function contentTypeFor(ext: string): string {
  return CONTENT_TYPES[ext.toLowerCase().replace(/^\./, '')] || 'application/octet-stream';
}

/** Rejects folder/extension values that could escape the storage root. */
export function assertSafeStoragePath(folder: string, ext: string) {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(folder)) throw new Error('Invalid storage folder.');
  if (!/^[a-zA-Z0-9]{1,8}$/.test(ext)) throw new Error('Invalid file extension.');
}
