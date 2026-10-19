import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshDatabase } from '../helpers/db';
import { getDb } from '@/lib/db';
import { createNovel, getNovel, listNovels, setCover } from '@/services/novels/service';
import { generateCovers } from '@/services/images/service';
import {
  validateCoverImageBuffer,
  getCloudinaryCoverConfig,
  deleteCloudinaryCover,
  MAX_COVER_IMAGE_BYTES,
  buildCoverFolder,
  buildCoverPublicId,
} from '@/services/covers/cloudinary-cover-service';
import { validateEnvConfig } from '@/lib/config/env';

const session = vi.hoisted(() => ({
  current: null as null | { id: string; email: string; name?: string },
}));

vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.current ? { user: session.current } : null),
}));

import { POST as generateCoverRoute, PUT as selectCoverRoute, GET as listCoversRoute } from '@/app/api/novels/[id]/cover/route';

function seedUser(id: string, email: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, name, role, status, freeNovelAccess, createdAt, updatedAt) VALUES (?, ?, ?, 'admin', 'active', 1, ?, ?)`,
  ).run(id, email, id, now, now);
}

describe('Cloudinary cover-image storage & cover-selection workflow', () => {
  const prevStorage = process.env.STORAGE_PROVIDER;
  const prevCloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const prevApiKey = process.env.CLOUDINARY_API_KEY;
  const prevApiSecret = process.env.CLOUDINARY_API_SECRET;
  const originalFetch = global.fetch;

  beforeEach(() => {
    freshDatabase();
    process.env.STORAGE_PROVIDER = 'cloudinary';
    process.env.CLOUDINARY_CLOUD_NAME = 'novelforge-cloud';
    process.env.CLOUDINARY_API_KEY = '123456789012345';
    process.env.CLOUDINARY_API_SECRET = 'super-secret-cloudinary-api-key-never-leak';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (prevStorage === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = prevStorage;
    if (prevCloudName === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = prevCloudName;
    if (prevApiKey === undefined) delete process.env.CLOUDINARY_API_KEY;
    else process.env.CLOUDINARY_API_KEY = prevApiKey;
    if (prevApiSecret === undefined) delete process.env.CLOUDINARY_API_SECRET;
    else process.env.CLOUDINARY_API_SECRET = prevApiSecret;
  });

  it('validates Cloudinary environment variables and rejects partial credentials on startup', () => {
    const cfg = getCloudinaryCoverConfig();
    expect(cfg.cloudName).toBe('novelforge-cloud');
    expect(cfg.apiKey).toBe('123456789012345');

    expect(() =>
      getCloudinaryCoverConfig({
        CLOUDINARY_CLOUD_NAME: 'novelforge-cloud',
        CLOUDINARY_API_KEY: '',
        CLOUDINARY_API_SECRET: '',
      } as any),
    ).toThrow(/Cloudinary cover storage is not configured/i);

    expect(() =>
      validateEnvConfig({
        NODE_ENV: 'development',
        STORAGE_PROVIDER: 'cloudinary',
        CLOUDINARY_CLOUD_NAME: 'novelforge-cloud',
      } as any),
    ).toThrow(/CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET/i);
  });

  it('validates real image content magic bytes (PNG, JPEG, WebP, SVG) and enforces file size limits', () => {
    // Valid PNG magic bytes (24 bytes with IHDR dimensions 768x1024)
    const pngBuf = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngBuf, 0);
    pngBuf.writeUInt32BE(768, 16);
    pngBuf.writeUInt32BE(1024, 20);
    expect(validateCoverImageBuffer(pngBuf)).toEqual({
      format: 'png',
      contentType: 'image/png',
      bytes: pngBuf.length,
      width: 768,
      height: 1024,
    });

    // Valid JPEG magic bytes
    const jpgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    expect(validateCoverImageBuffer(jpgBuf).format).toBe('jpg');

    // Valid WebP magic bytes
    const webpBuf = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'binary');
    expect(validateCoverImageBuffer(webpBuf).format).toBe('webp');

    // Valid SVG content
    const svgBuf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>');
    expect(validateCoverImageBuffer(svgBuf).format).toBe('svg');

    // Reject SVG containing <script>
    const maliciousSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(() => validateCoverImageBuffer(maliciousSvg)).toThrow(/disallowed active script content/i);

    // Reject arbitrary non-image bytes (spoofed extension)
    const fakeImg = Buffer.from('<!DOCTYPE html><html><body>Not an image</body></html>');
    expect(() => validateCoverImageBuffer(fakeImg)).toThrow(/Unsupported or corrupted cover image content/i);

    // Reject oversized buffer
    const hugePng = Buffer.alloc(MAX_COVER_IMAGE_BYTES + 1024);
    pngBuf.copy(hugePng, 0);
    expect(() => validateCoverImageBuffer(hugePng)).toThrow(/exceeds maximum allowed size/i);
  });

  it('does NOT upload every generated candidate variation to Cloudinary; uploads ONLY the selected cover', async () => {
    seedUser('author-1', 'author1@example.com');
    session.current = { id: 'author-1', email: 'author1@example.com' };

    const createdNovel = await createNovel('author-1', {
      title: 'Starlight Archive',
      genre: 'Science Fiction',
      tone: 'Epic',
      pov: 'Third Person Limited',
      targetWords: 75000,
      targetPages: 240,
      targetChapters: 15,
      writingMode: 'chapter',
    });
    const novelId = createdNovel.id;

    const cloudinaryCalls: Array<{ url: string; body: FormData }> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('api.cloudinary.com')) {
        const body = init?.body as FormData;
        cloudinaryCalls.push({ url, body });
        const folder = String(body.get('folder') || '');
        const pubId = String(body.get('public_id') || '');
        const fullPublicId = folder ? `${folder}/${pubId}` : pubId;
        return new Response(
          JSON.stringify({
            public_id: fullPublicId,
            secure_url: `https://res.cloudinary.com/novelforge-cloud/image/upload/v1700000000/${fullPublicId}.svg`,
            format: 'svg',
            bytes: 1420,
            width: 768,
            height: 1024,
            created_at: '2026-10-18T12:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    }) as any;

    // Step 2: Generate 3 cover candidates via POST /api/novels/[id]/cover
    const genRes = await generateCoverRoute(
      new Request(`http://localhost/api/novels/${novelId}/cover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variants: 3 }),
      }),
      { params: { id: novelId } },
    );
    expect(genRes.status).toBe(200);
    const candidates = await genRes.json();
    expect(candidates).toHaveLength(3);

    // Crucial requirement: NO Cloudinary upload should have happened during candidate generation
    expect(cloudinaryCalls).toHaveLength(0);

    // Step 4-8: User selects candidate #2 via PUT /api/novels/[id]/cover
    const chosenId = candidates[1].imageId;
    const selRes = await selectCoverRoute(
      new Request(`http://localhost/api/novels/${novelId}/cover`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageId: chosenId }),
      }),
      { params: { id: novelId } },
    );
    expect(selRes.status).toBe(200);
    const selBody = await selRes.json();
    expect(selBody.ok).toBe(true);

    // Exactly ONE Cloudinary upload occurred for the selected candidate
    expect(cloudinaryCalls).toHaveLength(1);
    expect(cloudinaryCalls[0].url).toContain('/image/upload');

    const expectedPublicId = buildCoverPublicId('author-1', novelId, chosenId);
    const expectedFolder = buildCoverFolder('author-1', novelId);
    expect(selBody.cover.publicId).toBe(expectedPublicId);
    expect(selBody.cover.secureUrl).toBe(
      `https://res.cloudinary.com/novelforge-cloud/image/upload/v1700000000/${expectedPublicId}.svg`,
    );
    expect(selBody.cover.isPrimary).toBe(true);
    // Secret must never appear in API response
    expect(JSON.stringify(selBody)).not.toContain('super-secret-cloudinary-api-key-never-leak');

    // Step 9-10: Verify database persistence across reloads (`getNovel`, `listNovels`, `GET /api/novels/[id]/cover`)
    const reloadedNovel = await getNovel(novelId, 'author-1');
    expect(reloadedNovel?.coverImageId).toBe(chosenId);
    expect(reloadedNovel?.coverUrl).toBe(selBody.cover.secureUrl);

    const dashboardNovels = await listNovels('author-1');
    expect(dashboardNovels[0].coverUrl).toBe(selBody.cover.secureUrl);

    const listRes = await listCoversRoute(
      new Request(`http://localhost/api/novels/${novelId}/cover`),
      { params: { id: novelId } },
    );
    const listedCovers = await listRes.json();
    const primaryCover = listedCovers.find((c: any) => c.id === chosenId);
    expect(primaryCover.isPrimary).toBe(1);
    expect(primaryCover.publicId).toBe(expectedPublicId);
    expect(primaryCover.folder).toBe(expectedFolder);
    expect(primaryCover.secureUrl).toBe(selBody.cover.secureUrl);
  });

  it('replaces an old Cloudinary cover and deletes the superseded Cloudinary asset after DB commit', async () => {
    seedUser('author-replace', 'replace@example.com');
    const createdNovel = await createNovel('author-replace', {
      title: 'Cover Replacement Novel',
      genre: 'Mystery',
      tone: 'Noir',
      pov: 'First Person',
      targetWords: 60000,
      targetPages: 190,
      targetChapters: 12,
      writingMode: 'chapter',
    });
    const novelId = createdNovel.id;

    const candidates = await generateCovers('author-replace', novelId, undefined, 2);
    const firstId = candidates[0].imageId;
    const secondId = candidates[1].imageId;

    const uploadedIds: string[] = [];
    const destroyedIds: string[] = [];

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body as FormData;
      if (url.includes('/image/upload')) {
        const folder = String(body.get('folder') || '');
        const pubId = String(body.get('public_id') || '');
        const fullPublicId = folder ? `${folder}/${pubId}` : pubId;
        uploadedIds.push(fullPublicId);
        return new Response(
          JSON.stringify({
            public_id: fullPublicId,
            secure_url: `https://res.cloudinary.com/novelforge-cloud/image/upload/v1/${fullPublicId}.svg`,
            format: 'svg',
            bytes: 1200,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/image/destroy')) {
        destroyedIds.push(String(body.get('public_id') || ''));
        return new Response(JSON.stringify({ result: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    }) as any;

    // Select cover #1
    await setCover(novelId, 'author-replace', firstId);
    expect(uploadedIds).toHaveLength(1);
    expect(destroyedIds).toHaveLength(0);

    // Select cover #2 — should upload cover #2 and destroy cover #1's Cloudinary asset
    await setCover(novelId, 'author-replace', secondId);
    expect(uploadedIds).toHaveLength(2);
    expect(destroyedIds).toEqual([buildCoverPublicId('author-replace', novelId, firstId)]);

    const novel = await getNovel(novelId, 'author-replace');
    expect(novel?.coverImageId).toBe(secondId);
  });

  it('preserves novel and existing cover when Cloudinary upload fails, and never leaks secrets', async () => {
    seedUser('author-fail', 'fail@example.com');
    const createdNovel = await createNovel('author-fail', {
      title: 'Resilient Novel',
      genre: 'Thriller',
      tone: 'Tense',
      pov: 'Third Person Limited',
      targetWords: 60000,
      targetPages: 190,
      targetChapters: 12,
      writingMode: 'chapter',
    });
    const novelId = createdNovel.id;

    const candidates = await generateCovers('author-fail', novelId, undefined, 1);

    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { message: 'Cloudinary upstream error for secret super-secret-cloudinary-api-key-never-leak' },
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    let caught: Error | null = null;
    try {
      await setCover(novelId, 'author-fail', candidates[0].imageId);
    } catch (err: any) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught?.message).not.toContain('super-secret-cloudinary-api-key-never-leak');

    // Novel must still exist and its coverImageId must remain null (uncorrupted)
    const novel = await getNovel(novelId, 'author-fail');
    expect(novel).not.toBeNull();
    expect(novel?.coverImageId).toBeNull();
  });

  it('cleans up the newly uploaded Cloudinary asset if the database update fails after upload', async () => {
    seedUser('author-rollback', 'rollback@example.com');
    const createdNovel = await createNovel('author-rollback', {
      title: 'Atomic Cover Novel',
      genre: 'Fantasy',
      tone: 'Dark',
      pov: 'Third Person Limited',
      targetWords: 60000,
      targetPages: 190,
      targetChapters: 12,
      writingMode: 'chapter',
    });
    const novelId = createdNovel.id;

    const candidates = await generateCovers('author-rollback', novelId, undefined, 1);
    const chosenId = candidates[0].imageId;

    const destroyedPublicIds: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body as FormData;
      if (url.includes('/image/upload')) {
        const folder = String(body.get('folder') || '');
        const pubId = String(body.get('public_id') || '');
        const fullPublicId = folder ? `${folder}/${pubId}` : pubId;
        return new Response(
          JSON.stringify({
            public_id: fullPublicId,
            secure_url: `https://res.cloudinary.com/novelforge-cloud/image/upload/v1/${fullPublicId}.svg`,
            format: 'svg',
            bytes: 1100,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/image/destroy')) {
        destroyedPublicIds.push(String(body.get('public_id') || ''));
        return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
      }
      return originalFetch(input, init);
    }) as any;

    // Simulate a database failure inside db.transaction during setCover
    const db = getDb();
    const origTransaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
      return (() => {
        throw new Error('simulated DB commit failure');
      }) as any;
    });

    await expect(setCover(novelId, 'author-rollback', chosenId)).rejects.toThrow('simulated DB commit failure');

    // Verify the orphaned Cloudinary asset was immediately cleaned up!
    expect(destroyedPublicIds).toEqual([
      buildCoverPublicId('author-rollback', novelId, chosenId),
    ]);

    db.transaction = origTransaction;
  });

  it('rejects unauthorized cover selection and cross-user Cloudinary asset deletion', async () => {
    seedUser('owner-a', 'ownera@example.com');
    seedUser('intruder-b', 'intruderb@example.com');

    const createdNovelA = await createNovel('owner-a', {
      title: 'Owner A Private Novel',
      genre: 'Drama',
      tone: 'Intimate',
      pov: 'First Person',
      targetWords: 50000,
      targetPages: 160,
      targetChapters: 10,
      writingMode: 'chapter',
    });
    const novelA = createdNovelA.id;

    const createdNovelB = await createNovel('intruder-b', {
      title: 'Intruder B Novel',
      genre: 'Drama',
      tone: 'Intimate',
      pov: 'First Person',
      targetWords: 50000,
      targetPages: 160,
      targetChapters: 10,
      writingMode: 'chapter',
    });
    const novelB = createdNovelB.id;

    const coversA = await generateCovers('owner-a', novelA, undefined, 1);

    // Intruder B cannot select Owner A's cover on Novel A or attach it to Novel B
    await expect(setCover(novelA, 'intruder-b', coversA[0].imageId)).rejects.toThrow(/not found/i);
    await expect(setCover(novelB, 'intruder-b', coversA[0].imageId)).rejects.toThrow(/not found/i);

    // Intruder B cannot delete Owner A's Cloudinary cover asset
    const ownerAPublicId = buildCoverPublicId('owner-a', novelA, coversA[0].imageId);
    await expect(
      deleteCloudinaryCover(ownerAPublicId, { userId: 'intruder-b', novelId: novelB }),
    ).rejects.toThrow(/Refusing to delete a Cloudinary cover outside the novel owner namespace/i);
  });
});
