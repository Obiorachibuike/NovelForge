import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { s3Driver, readS3Config } from '@/lib/storage/s3';
import { __setStorageDriverForTests, saveFile, readFile, deleteFile, storageProviderName, storageInfo } from '@/lib/storage';

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const requests: Recorded[] = [];
const objects = new Map<string, Buffer>();
let server: http.Server;
let origin = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });

      if (req.method === 'PUT') {
        objects.set(req.url!, body);
        res.writeHead(200, { etag: '"fake-etag"' }).end();
        return;
      }
      if (req.method === 'GET') {
        const found = objects.get(req.url!);
        if (!found) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': 'image/png' }).end(found);
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(req.url!);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(400).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const S3_ENV = {
  STORAGE_PROVIDER: 's3',
  S3_BUCKET: 'novelforge-test',
  S3_REGION: 'eu-central-1',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  S3_FORCE_PATH_STYLE: 'true',
  S3_PREFIX: 'novelforge',
};

function applyEnv(extra: Record<string, string> = {}) {
  Object.assign(process.env, S3_ENV, { S3_ENDPOINT: origin }, extra);
  __setStorageDriverForTests(null);
}

function clearEnv() {
  for (const key of [...Object.keys(S3_ENV), 'S3_ENDPOINT', 'S3_PUBLIC_BASE_URL']) delete process.env[key];
  __setStorageDriverForTests(null);
}

afterEach(() => {
  requests.length = 0;
  objects.clear();
  clearEnv();
});

describe('S3-compatible object storage', () => {
  it('uploads with a signed request and returns an app-proxied URL by default', async () => {
    applyEnv();
    const data = Buffer.from('pretend png bytes');
    const stored = await saveFile({ data, folder: 'covers', ext: 'png' });

    expect(stored.key).toMatch(/^covers\/.+\.png$/);
    expect(stored.url).toBe(`/api/files/${stored.key}`);
    expect(stored.size).toBe(data.length);

    const put = requests.find(r => r.method === 'PUT')!;
    expect(put).toBeTruthy();
    // Path style endpoint + bucket + prefix are all part of the object path.
    expect(put.url).toBe(`/novelforge-test/novelforge/${stored.key}`);
    expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/eu-central-1\/s3\/aws4_request/);
    expect(put.headers['x-amz-date']).toBeTruthy();
    expect(put.headers['content-type']).toBe('image/png');
    expect(Buffer.from(put.body).toString()).toBe(data.toString());
  });

  it('reads back and deletes the same object', async () => {
    applyEnv();
    objects.set('/novelforge-test/novelforge/covers/existing.png', Buffer.from('stored bytes'));

    const read = await readFile('covers/existing.png');
    expect(read?.data.toString()).toBe('stored bytes');
    expect(read?.contentType).toBe('image/png');

    await deleteFile('covers/existing.png');
    expect(requests.some(r => r.method === 'DELETE' && r.url === '/novelforge-test/novelforge/covers/existing.png')).toBe(true);
    expect(await readFile('covers/existing.png')).toBeNull();
  });

  it('returns null (not a throw) when the object is missing', async () => {
    applyEnv();
    expect(await readFile('covers/absent.png')).toBeNull();
  });

  it('uses a CDN base URL when one is configured', async () => {
    applyEnv({ S3_PUBLIC_BASE_URL: 'https://cdn.example.com/' });
    const stored = await saveFile({ data: Buffer.from('x'), folder: 'exports', ext: 'pdf' });
    expect(stored.url).toBe(`https://cdn.example.com/novelforge/${stored.key}`);
  });

  it('fails with an actionable message when credentials are missing, and unknown providers throw', async () => {
    process.env.STORAGE_PROVIDER = 's3';
    for (const key of ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) delete process.env[key];
    __setStorageDriverForTests(null);
    expect(() => readS3Config()).toThrow(/docs\/storage\.md/);

    process.env.STORAGE_PROVIDER = 'dropbox';
    expect(() => storageProviderName()).toThrow(/Unknown STORAGE_PROVIDER/);

    process.env.STORAGE_PROVIDER = 'local';
    const info = await storageInfo();
    expect(info.provider).toBe('local');
    expect(info.persistent).toBe(true);
  });
});
