import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import 'server-only';

interface SaveFileOptions {
  data: Buffer;
  folder: string;
  ext: string;
}

/** Local storage for development or a persistent, single-instance Node server. */
export async function saveFile({ data, folder, ext }: SaveFileOptions): Promise<{ key: string; url: string }> {
  const provider = process.env.STORAGE_PROVIDER || 'local';
  if (provider !== 'local') {
    throw new Error(`Storage provider "${provider}" is not implemented. Use local storage on a persistent Node server.`);
  }
  if (process.env.VERCEL) {
    throw new Error('Local uploads are not persistent on Vercel. Configure a persistent storage adapter before generating covers or exports.');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(folder) || !/^[a-zA-Z0-9]+$/.test(ext)) {
    throw new Error('Invalid storage folder or file extension.');
  }
  const key = `${folder}/${nanoid()}.${ext}`;
  const directory = path.join(process.cwd(), 'public', 'uploads', folder);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(process.cwd(), 'public', 'uploads', key), data, { flag: 'wx' });
  return { key, url: `/uploads/${key}` };
}
