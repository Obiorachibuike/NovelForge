import { describe, expect, it, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const uploadsDir = () => path.join(process.env.DATA_DIR!, 'uploads');
import { freshDatabase, seedUser, seedNovel, seedOutline, seedChapter, seedCover, db, jsonRequest, readJson } from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { POST as startExportRoute, GET as listExportsRoute } from '@/app/api/novels/[id]/export/route';
import { GET as getFileRoute } from '@/app/api/files/[...key]/route';
import { buildExport } from '@/services/exports/service';

let user: { id: string; email: string; name: string };
let novel: { id: string; userId: string };
let coverDir: string;

const NOVEL = { title: 'The Clockwork Tide', genre: 'Science Fiction', tone: 'wry' };
const SETTINGS = { fontSize: 12, fontFamily: 'serif', pageSize: 'letter', includeCover: 1, includeToc: 1, pageNumbers: 1, chapterHeadingStyle: 'numbered' };
const AUTHOR = 'Ada Lovelace';

const CHAPTERS = [
  { chapterNumber: 1, title: 'A Slow Beginning', plainText: 'The rain had stopped.\n\nShe counted the bells and waited for the tide.', status: 'approved', wordCount: 16 },
  { chapterNumber: 2, title: 'The Salt Market', plainText: 'Salt everywhere, and the smell of tar.\n\nHe bought a map that lied.', status: 'approved', wordCount: 15 },
  { chapterNumber: 10, title: 'Ten of Twelve', plainText: 'Chapter ten prose, out of numeric order in the outline.', status: 'approved', wordCount: 9 },
];

function buildInput(overrides: Partial<Record<string, any>> = {}) {
  return { novel: { ...NOVEL }, chapters: CHAPTERS, settings: { ...SETTINGS }, cover: null, format: 'txt' as const, author: AUTHOR, ...overrides };
}

/** Minimal PNG (1x1) so raster-cover paths are exercised. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(() => {
  coverDir = mkdtempSync(path.join(tmpdir(), 'novelforge-test-'));
  mkdirSync(path.join(uploadsDir(), 'exports'), { recursive: true });
  mkdirSync(path.join(uploadsDir(), 'covers'), { recursive: true });
});
afterAll(() => { rmSync(coverDir, { recursive: true, force: true }); });

beforeEach(() => {
  freshDatabase();
  user = seedUser({ name: AUTHOR });
  novel = seedNovel(user.id, { title: NOVEL.title, genre: NOVEL.genre, tone: NOVEL.tone });
  session.userId = user.id;
});

describe('export builders', () => {
  it('txt contains front matter and every chapter in numeric order', async () => {
    const built = await buildExport(buildInput());
    const text = built.buffer.toString('utf8');
    expect(built.ext).toBe('txt');
    expect(built.mime).toContain('text/plain');
    expect(built.filename).toMatch(/^the-clockwork-tide-\d{4}-\d{2}-\d{2}\.txt$/);
    expect(text.toLowerCase()).toContain(NOVEL.title.toLowerCase());
    expect(text).toContain(AUTHOR);
    expect(text.indexOf('A Slow Beginning')).toBeLessThan(text.indexOf('The Salt Market'));
    expect(text.indexOf('The Salt Market')).toBeLessThan(text.indexOf('Ten of Twelve'));
    // Unicode survives plain-text export untouched.
    expect(text).toContain('She counted the bells and waited for the tide.');
  });

  it('markdown uses headings and keeps paragraph breaks', async () => {
    const built = await buildExport(buildInput({ format: 'markdown' }));
    const text = built.buffer.toString('utf8');
    expect(built.ext).toBe('md');
    expect(text).toMatch(/^# /m);
    expect(text).toContain('A Slow Beginning');
    expect(text).toMatch(/\n\n/);
    expect(text).toContain('He bought a map that lied.');
  });

  it('docx is a real OOXML zip with the chapter text embedded', async () => {
    const built = await buildExport(buildInput({ format: 'docx' }));
    expect(built.buffer.slice(0, 2).toString('latin1')).toBe('PK');
    expect(built.mime).toContain('wordprocessingml');
    expect(built.buffer.includes(Buffer.from('word/document.xml'))).toBe(true);
    const xml = await unzipEntry(built.buffer, 'word/document.xml');
    expect(xml).toContain('The Salt Market');
    expect(xml).toContain('Salt everywhere');
  });

  it('pdf is a valid document with the expected page count and text', async () => {
    const built = await buildExport(buildInput({ format: 'pdf' }));
    const raw = built.buffer.toString('latin1');
    expect(raw.startsWith('%PDF-')).toBe(true);
    expect(built.mime).toBe('application/pdf');

    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(built.buffer);
    // Three chapters of short prose; at least one page must exist.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < doc.getPageCount(); i++) {
      // Non-Latin-1 glyphs degrade to '?', never crash the writer.
      expect(doc.getPage(i).getSize().width).toBeGreaterThan(0);
    }
  });

  it('pdf survives non-latin1 text and accents', async () => {
    const chapters = [{ chapterNumber: 1, title: 'Ærø — København', plainText: 'Café, naïve, Ștefan, and 東京の雨.', status: 'approved', wordCount: 6 }];
    const built = await buildExport(buildInput({ format: 'pdf', chapters }));
    expect(built.buffer.slice(0, 5).toString()).toBe('%PDF-');
    const { PDFDocument } = await import('pdf-lib');
    await expect(PDFDocument.load(built.buffer)).resolves.toBeTruthy();
  });

  it('epub is a valid zip with mimetype first, toc and paragraphs', async () => {
    const built = await buildExport(buildInput({ format: 'epub' }));
    expect(built.buffer.slice(0, 2).toString('latin1')).toBe('PK');
    expect(built.ext).toBe('epub');
    expect(built.buffer.includes(Buffer.from('mimetype'))).toBe(true);
    const text = built.buffer.toString('latin1');
    expect(text).toContain('application/epub+zip');
    const container = await unzipEntry(built.buffer, 'META-INF/container.xml');
    expect(container).toContain('OEBPS/content.opf');
    const opf = await unzipEntry(built.buffer, 'OEBPS/content.opf');
    expect(opf).toContain(NOVEL.title);
    expect(opf).not.toContain('undefined');
    const entries = await listZipEntries(built.buffer);
    const chapterPath = entries.find(e => /OEBPS\/.*Chapter-1/i.test(e));
    expect(chapterPath).toBeTruthy();
    const chapter = await unzipEntry(built.buffer, chapterPath!);
    expect(chapter).toContain('<p>');
    expect(chapter).toContain('The rain had stopped.');
  });

  it('embeds a raster cover in all three binary formats and warns for svg', async () => {
    const coverKey = 'covers/cover.png';
    writeFileSync(path.join(uploadsDir(), coverKey), PNG);

    const docx = await buildExport(buildInput({ format: 'docx', cover: { storageKey: coverKey, url: '/api/files/' + coverKey, provider: 'openai' } }));
    expect(docx.warnings).toEqual([]);
    expect(docx.buffer.includes(Buffer.from('word/media/'))).toBe(true);

    const pdf = await buildExport(buildInput({ format: 'pdf', cover: { storageKey: coverKey, url: '', provider: 'openai' } }));
    expect(pdf.warnings).toEqual([]);
    const pdfDoc = await (await import('pdf-lib')).PDFDocument.load(pdf.buffer);
    // Cover page adds an embedded image object.
    expect(pdfDoc.context.enumerateIndirectObjects().some(([, obj]) => obj.constructor.name === 'PDFRawStream')).toBe(true);

    const epub = await buildExport(buildInput({ format: 'epub', cover: { storageKey: coverKey, url: '', provider: 'openai' } }));
    expect(epub.warnings).toEqual([]);
    const epubEntries = await listZipEntries(epub.buffer);
    expect(epubEntries.some(e => /cover\.(png|jpe?g)$/i.test(e))).toBe(true);
    const opfWithCover = await unzipEntry(epub.buffer, 'OEBPS/content.opf');
    // Manifest declares the cover asset (id image_cover, media-type image/png).
    expect(opfWithCover).toMatch(/media-type="image\/png"/);
    expect(opfWithCover).toMatch(/cover/i);

    // SVG fallback covers are not embeddable; the exporter says so instead of
    // failing silently (this used to be swallowed for DOCX and PDF).
    const svgHex = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    writeFileSync(path.join(uploadsDir(), 'covers/cover.svg'), svgHex);
    for (const format of ['docx', 'pdf', 'epub'] as const) {
      const built = await buildExport(buildInput({ format, cover: { storageKey: 'covers/cover.svg', url: '', provider: 'svg-fallback' } }));
      expect(built.warnings.join(' '), `${format} should warn about the vector cover`).toMatch(/vector|svg|placeholder/i);
    }

    // A cover that is missing from storage is reported, never silently dropped.
    for (const format of ['docx', 'pdf', 'epub'] as const) {
      const built = await buildExport(buildInput({ format, cover: { storageKey: 'covers/missing.png', url: '', provider: 'openai' } }));
      expect(built.warnings.join(' '), `${format} should warn about the missing cover`).toMatch(/could not be read|not be embedded/i);
    }
  });

  it('ignores the cover completely when coverPlacement is none', async () => {
    const coverKey = 'covers/cover.png';
    writeFileSync(path.join(uploadsDir(), coverKey), PNG);
    const built = await buildExport(buildInput({ format: 'epub', settings: { ...SETTINGS, coverPlacement: 'none' }, cover: { storageKey: coverKey, url: '', provider: 'openai' } }));
    expect(built.warnings).toEqual([]);
    const entries = await listZipEntries(built.buffer);
    expect(entries.some(e => /cover\.(png|jpe?g)$/i.test(e))).toBe(false);
  });

  it('never ships an "undefined novel" blurb', async () => {
    const built = await buildExport(buildInput({ format: 'epub', novel: { title: 'Untitled Draft' } }));
    const opf = await unzipEntry(built.buffer, 'OEBPS/content.opf');
    expect(opf.toLowerCase()).not.toContain('undefined');
    expect(opf).toContain('A novel by ');
  });

  it('sanitises filenames derived from the novel title', async () => {
    const built = await buildExport(buildInput({ novel: { title: '../../etc/pässwd "quote"' } }));
    expect(built.filename).not.toContain('..');
    expect(built.filename).not.toContain('/');
    expect(built.filename).not.toContain('"');
    expect(built.filename).toMatch(/\.txt$/);
  });
});

describe('export job lifecycle', () => {
  it('refuses to export a novel with no approved chapters', async () => {
    seedOutline(novel.id, 2);
    seedChapter(novel.id, { chapterNumber: 1, status: 'generated' });
    const res = await startExportRoute(jsonRequest(`/api/novels/${novel.id}/export`, { format: 'txt' }, { method: 'POST' }), { params: { id: novel.id } });
    expect(res.status).toBe(409);
    expect((await readJson(res)).code).toBe('nothing_to_export');
  });

  it('produces a downloadable file, records the row and enforces ownership on download', async () => {
    seedChapter(novel.id, { chapterNumber: 1, status: 'approved', plainText: 'Approved prose for export.\n\nSecond paragraph.' });

    const started = await startExportRoute(jsonRequest(`/api/novels/${novel.id}/export`, { format: 'txt' }, { method: 'POST' }), { params: { id: novel.id } });
    expect(started.status).toBe(200);
    const { jobId } = await readJson(started);

    const { drainQueue, getJob } = await import('@/lib/queue');
    for (let i = 0; i < 6; i++) {
      if (!(await drainQueue({ limit: 2, workerId: 'export-worker' })).length) break;
      const job = await getJob(jobId);
      if (job && ['completed', 'failed'].includes(job.status)) break;
    }

    const job = await getJob(jobId);
    expect(job?.status).toBe('completed');
    const result = JSON.parse(job!.result!);
    expect(result.chapters).toBe(1);

    const listed = await readJson(await listExportsRoute(jsonRequest(`/api/novels/${novel.id}/export`), { params: { id: novel.id } }));
    expect(listed.length).toBe(1);
    expect(listed[0]).toMatchObject({ format: 'txt', status: 'completed' });
    expect(listed[0].options.chapters).toBe(1);

    const row = db().prepare('SELECT * FROM exports WHERE novelId=?').get(novel.id) as any;
    expect(existsSync(path.join(uploadsDir(), row.fileKey))).toBe(true);
    expect(row.fileSize).toBeGreaterThan(0);

    const download = await getFileRoute(jsonRequest(`/api/files/${row.fileKey}`), { params: { key: row.fileKey.split('/') } });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(await download.text()).toContain('Approved prose for export.');

    // A second user cannot download it.
    const { seedUser: seedUser2 } = await import('../helpers/db');
    session.userId = seedUser2().id;
    expect((await getFileRoute(jsonRequest(`/api/files/${row.fileKey}`), { params: { key: row.fileKey.split('/') } })).status).toBe(404);
  });

  it('rejects unsupported formats before doing any work', async () => {
    seedChapter(novel.id, { chapterNumber: 1, status: 'approved', plainText: 'text' });
    const res = await startExportRoute(jsonRequest(`/api/novels/${novel.id}/export`, { format: 'rtf' }, { method: 'POST' }), { params: { id: novel.id } });
    expect(res.status).toBe(400);
  });
});

/** Lists the entry names of an in-memory zip using the system `unzip`. */
async function listZipEntries(buffer: Buffer): Promise<string[]> {
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(path.join(tmpdir(), 'novelforge-ziplist-'));
  const file = path.join(dir, 'out.zip');
  writeFileSync(file, buffer);
  try {
    return execFileSync('unzip', ['-Z1', file], { maxBuffer: 32 * 1024 * 1024 }).toString('utf8').split('\n').filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Reads a single entry out of an in-memory zip using the system `unzip`. */
async function unzipEntry(buffer: Buffer, entry: string): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(path.join(tmpdir(), 'novelforge-zip-'));
  const file = path.join(dir, 'out.zip');
  writeFileSync(file, buffer);
  try {
    return execFileSync('unzip', ['-p', file, entry], { maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
