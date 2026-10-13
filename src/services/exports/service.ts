import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import { saveFile, readFile } from '@/lib/storage';
import { registerHandler } from '@/lib/queue';
import { HttpError } from '@/lib/api/http';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak, ImageRun, AlignmentType, Footer, PageNumber } from 'docx';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { NovelSettingsRow } from '@/types';
import 'server-only';

export type ExportFormat = 'pdf' | 'docx' | 'epub' | 'txt' | 'markdown';

export interface ExportBuildResult {
  buffer: Buffer;
  ext: string;
  mime: string;
  filename: string;
  warnings: string[];
}

export async function enqueueExport(userId: string, novelId: string, format: ExportFormat, options?: unknown) {
  const db = getDb();
  const novel = db.prepare('SELECT id FROM novels WHERE id = ? AND userId = ?').get(novelId, userId);
  if (!novel) throw new HttpError(404, 'Novel not found', 'novel_not_found');
  const approved = db.prepare(`SELECT COUNT(*) AS c FROM chapters WHERE novelId = ? AND status='approved'`).get(novelId) as any;
  if (!approved.c) throw new HttpError(409, 'There are no approved chapters to export yet.', 'nothing_to_export');
  const { enqueue } = await import('@/lib/queue');
  return enqueue({ type: 'export', userId, novelId, payload: { format, options } });
}

export async function runExport({ novelId, userId, payload }: any) {
  const db = getDb();
  const novel = db.prepare('SELECT * FROM novels WHERE id=? AND userId=?').get(novelId, userId) as any;
  if (!novel) throw new Error('Novel not found');
  const settings = db.prepare('SELECT * FROM novel_settings WHERE novelId=?').get(novelId) as NovelSettingsRow | undefined;
  const chapters = db.prepare(
    `SELECT chapterNumber, title, plainText, status, wordCount FROM chapters
      WHERE novelId=? AND status='approved' ORDER BY chapterNumber ASC`,
  ).all(novelId) as any[];
  const author = (db.prepare('SELECT name FROM users WHERE id=?').get(userId) as any)?.name || 'Anonymous';
  const cover = novel.coverImageId
    ? db.prepare('SELECT storageKey, url, provider FROM image_assets WHERE id=?').get(novel.coverImageId) as any
    : null;

  const format = (payload?.format || 'txt') as ExportFormat;
  const options = { ...(settings as any), ...(payload?.options || {}) };
  const built = await buildExport({ novel, chapters, settings: options, cover, format, author });

  const stored = await saveFile({ data: built.buffer, folder: 'exports', ext: built.ext });
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO exports (id,userId,novelId,format,status,fileKey,fileUrl,fileSize,options,completedAt,createdAt,mimeType)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, userId, novelId, format, 'completed', stored.key, stored.url, built.buffer.length,
    JSON.stringify({ ...options, filename: built.filename, warnings: built.warnings, chapters: chapters.length }),
    now, now, built.mime,
  );
  return { exportId: id, url: stored.url, bytes: built.buffer.length, warnings: built.warnings, chapters: chapters.length };
}

registerHandler('export', runExport);

interface BuildInput {
  novel: any;
  chapters: any[];
  settings: NovelSettingsRow | any;
  cover: { storageKey: string; url: string; provider?: string } | null;
  format: ExportFormat;
  author: string;
}

export async function buildExport(input: BuildInput): Promise<ExportBuildResult> {
  const slug = slugify(input.novel.title || 'novel');
  const stamp = new Date().toISOString().slice(0, 10);
  switch (input.format) {
    case 'docx': {
      const { buffer, warnings } = await buildDocx(input);
      return { buffer, ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: `${slug}-${stamp}.docx`, warnings };
    }
    case 'pdf': {
      const { buffer, warnings } = await buildPdf(input);
      return { buffer, ext: 'pdf', mime: 'application/pdf', filename: `${slug}-${stamp}.pdf`, warnings };
    }
    case 'epub': {
      const { buffer, warnings } = await buildEpub(input);
      return { buffer, ext: 'epub', mime: 'application/epub+zip', filename: `${slug}-${stamp}.epub`, warnings };
    }
    case 'markdown': {
      return {
        buffer: Buffer.from(buildMarkdown(input), 'utf8'),
        ext: 'md', mime: 'text/markdown; charset=utf-8', filename: `${slug}-${stamp}.md`, warnings: [],
      };
    }
    case 'txt':
    default: {
      return {
        buffer: Buffer.from(buildTxt(input), 'utf8'),
        ext: 'txt', mime: 'text/plain; charset=utf-8', filename: `${slug}-${stamp}.txt`, warnings: [],
      };
    }
  }
}

function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'novel';
}

function totalWords(chapters: any[]) {
  return chapters.reduce((sum, c) => sum + (c.wordCount ?? countWords(c.plainText || '')), 0);
}

function countWords(text: string) {
  return text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

/** Cover images that can be embedded in DOCX/PDF/EPUB (raster only). */
async function loadRasterCover(cover: BuildInput['cover'], warnings: string[]) {
  if (!cover?.storageKey) return null;
  const ext = cover.storageKey.split('.').pop()?.toLowerCase() || '';
  if (!['png', 'jpg', 'jpeg'].includes(ext)) {
    warnings.push('The selected cover is a vector (SVG) image and was not embedded in this format.');
    return null;
  }
  const file = await readFile(cover.storageKey);
  if (!file) {
    warnings.push('The selected cover image could not be read from storage.');
    return null;
  }
  return { data: file.data, ext: ext === 'jpg' || ext === 'jpeg' ? 'jpg' : 'png' } as const;
}

function buildTxt({ novel, chapters, settings, author }: BuildInput) {
  const parts: string[] = [];
  if (settings.includeFrontMatter !== 0 && settings.includeFrontMatter !== false) {
    parts.push(novel.title.toUpperCase(), '', `by ${author}`, '', 'A Novel', '', '');
    parts.push(`Manuscript: ${chapters.length} chapters · ${totalWords(chapters).toLocaleString()} words`, '', '');
  }
  if (settings.includeToc !== 0 && settings.includeToc !== false) {
    parts.push('CONTENTS', '');
    for (const c of chapters) parts.push(`Chapter ${c.chapterNumber}: ${c.title}`);
    parts.push('', '');
  }
  for (const c of chapters) {
    parts.push(`Chapter ${c.chapterNumber}: ${c.title}`, '', c.plainText || '', '', '');
  }
  return parts.join('\n');
}

function buildMarkdown({ novel, chapters, settings, author }: BuildInput) {
  const parts: string[] = [];
  if (settings.includeFrontMatter !== 0 && settings.includeFrontMatter !== false) {
    parts.push(`# ${novel.title}`, '', `*by ${author}*`, '');
    parts.push(`> Manuscript: ${chapters.length} chapters · ${totalWords(chapters).toLocaleString()} words`, '');
  }
  if (settings.includeToc !== 0 && settings.includeToc !== false) {
    parts.push('## Contents', '');
    for (const c of chapters) parts.push(`- [Chapter ${c.chapterNumber}: ${c.title}](#chapter-${c.chapterNumber})`);
    parts.push('');
  }
  for (const c of chapters) {
    parts.push(`## Chapter ${c.chapterNumber}: ${c.title}`, '', c.plainText || '', '');
  }
  return parts.join('\n');
}

async function buildDocx(input: BuildInput): Promise<{ buffer: Buffer; warnings: string[] }> {
  const { novel, chapters, settings, author } = input;
  const warnings: string[] = [];
  const cover = settings.coverPlacement === 'none' ? null : await loadRasterCover(input.cover, warnings);
  const fontSize = Math.round((Number(settings.fontSize) || 12) * 2); // half-points
  const spacing = { line: Math.round((Number(settings.lineSpacing) || 1.6) * 240), after: 120 };

  const children: any[] = [];

  if (settings.includeFrontMatter !== 0 && settings.includeFrontMatter !== false) {
    if (cover) {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({ data: cover.data, transformation: { width: 360, height: 480 } })],
      }));
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun({ text: novel.title, bold: true, size: 56 })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `by ${author}`, italics: true, size: 28 })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `A Novel · ${totalWords(chapters).toLocaleString()} words`, size: 22 })] }));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  if (settings.includeToc !== 0 && settings.includeToc !== false) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Contents', bold: true })] }));
    for (const c of chapters) {
      children.push(new Paragraph({ spacing, children: [new TextRun({ text: `Chapter ${c.chapterNumber}: ${c.title}`, size: fontSize })] }));
    }
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  chapters.forEach((c, index) => {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: `Chapter ${c.chapterNumber}: ${c.title}`, bold: true })] }));
    for (const paragraph of (c.plainText || '').split(/\n{2,}/)) {
      children.push(new Paragraph({ spacing, children: [new TextRun({ text: paragraph.trim(), size: fontSize })] }));
    }
    if (index < chapters.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
  });

  const doc = new Document({
    sections: [{
      properties: {},
      footers: settings.pageNumbering && settings.pageNumbering !== 'none'
        ? {
            default: new Footer({
              children: [new Paragraph({
                alignment: settings.pageNumbering === 'top-right' ? AlignmentType.RIGHT : AlignmentType.CENTER,
                children: [new TextRun({ children: [PageNumber.CURRENT] })],
              })],
            }),
          }
        : undefined,
      children,
    }],
  });
  return { buffer: await Packer.toBuffer(doc), warnings };
}

const PAGE_SIZES: Record<string, [number, number]> = {
  letter: [612, 792],
  a4: [595, 842],
  a5: [420, 595],
  trade: [432, 648],
};

/** pdf-lib's standard fonts only cover WinAnsi: replace anything outside it. */
function toWinAnsi(text: string): string {
  return text.replace(/[^\u0000-\u00FF\u2018\u2019\u201C\u201D\u2013\u2014\u2026]/g, '?');
}

async function buildPdf(input: BuildInput): Promise<{ buffer: Buffer; warnings: string[] }> {
  const { novel, chapters, settings, author } = input;
  const warnings: string[] = [];
  const [pageWidth, pageHeight] = PAGE_SIZES[settings.pageSize as string] || PAGE_SIZES.letter;
  const margin = Math.min(Number(settings.margin) || 72, Math.floor(pageWidth / 4));
  const fontSize = Number(settings.fontSize) || 12;
  const leading = Math.round(fontSize * (Number(settings.lineSpacing) || 1.6));

  const pdf = await PDFDocument.create();
  pdf.setTitle(novel.title);
  pdf.setAuthor(author);
  const body: PDFFont = await pdf.embedFont(StandardFonts.TimesRoman);
  const bodyBold: PDFFont = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const width = pageWidth - margin * 2;

  let page: PDFPage = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const newPage = () => { page = pdf.addPage([pageWidth, pageHeight]); y = pageHeight - margin; };
  const ensure = (needed: number) => { if (y - needed < margin) newPage(); };
  const write = (text: string, font: PDFFont, size: number, opts: { center?: boolean; gap?: number; indent?: number } = {}) => {
    const gap = opts.gap ?? Math.round(size * 1.35);
    const indent = opts.indent ?? 0;
    for (const line of wrapText(toWinAnsi(text), font, size, width - indent)) {
      ensure(gap);
      const x = opts.center ? (pageWidth - font.widthOfTextAtSize(line, size)) / 2 : margin + indent;
      page.drawText(line, { x, y: y - size, font, size, color: rgb(0.08, 0.08, 0.1) });
      y -= gap;
    }
  };

  const includeFrontMatter = settings.includeFrontMatter !== 0 && settings.includeFrontMatter !== false;
  const includeToc = settings.includeToc !== 0 && settings.includeToc !== false;

  if (includeFrontMatter) {
    const cover = settings.coverPlacement === 'none' ? null : await loadRasterCover(input.cover, warnings);
    if (cover) {
      try {
        const image = cover.ext === 'png' ? await pdf.embedPng(cover.data) : await pdf.embedJpg(cover.data);
        const drawWidth = Math.min(width * 0.8, 420);
        const drawHeight = (image.height / image.width) * drawWidth;
        page.drawImage(image, { x: (pageWidth - drawWidth) / 2, y: pageHeight - margin - drawHeight, width: drawWidth, height: drawHeight });
        newPage();
      } catch {
        // An unreadable cover must not fail the whole export, but it must not
        // be swallowed either: the export says the cover was dropped.
        warnings.push('The selected cover image could not be embedded in the PDF and was skipped.');
      }
    }
    y = pageHeight * 0.72;
    write(novel.title, bodyBold, 28, { center: true, gap: 40 });
    write(`by ${author}`, body, 14, { center: true, gap: 30 });
    write(`A Novel · ${totalWords(chapters).toLocaleString()} words`, body, 11, { center: true, gap: 24 });
    newPage();
  }

  if (includeToc) {
    write('Contents', bodyBold, 18, { gap: 30 });
    for (const c of chapters) write(`Chapter ${c.chapterNumber}: ${c.title}`, body, Math.min(fontSize, 12), { gap: 18 });
    if (chapters.length) newPage();
  }

  chapters.forEach((c, index) => {
    if (index > 0) newPage();
    write(`Chapter ${c.chapterNumber}: ${c.title}`, bodyBold, Math.min(20, fontSize + 6), { gap: 30 });
    for (const paragraph of (c.plainText || '').split(/\n{2,}/)) {
      write(paragraph.trim(), body, fontSize, { gap: leading });
      y -= Math.round(leading * 0.4);
    }
  });

  if (settings.pageNumbering && settings.pageNumbering !== 'none') {
    pdf.getPages().forEach((p, i) => {
      const label = String(i + 1);
      const size = 9;
      const x = settings.pageNumbering === 'top-right'
        ? p.getWidth() - margin - body.widthOfTextAtSize(label, size)
        : (p.getWidth() - body.widthOfTextAtSize(label, size)) / 2;
      const yPos = settings.pageNumbering === 'top-right' ? p.getHeight() - margin / 2 : margin / 2;
      p.drawText(label, { x, y: yPos, font: body, size, color: rgb(0.35, 0.35, 0.38) });
    });
  }

  return { buffer: Buffer.from(await pdf.save()), warnings };
}

async function buildEpub(input: BuildInput): Promise<{ buffer: Buffer; warnings: string[] }> {
  const { novel, chapters, settings, author } = input;
  const warnings: string[] = [];
  const { default: Epub } = await import('epub-gen-memory');
  const cover = settings.coverPlacement === 'none' ? null : await loadRasterCover(input.cover, warnings);

  const content = chapters.map(c => ({
    title: `Chapter ${c.chapterNumber}: ${c.title}`,
    content: htmlFromPlainText(c.plainText || ''),
    excludeFromToc: false,
    beforeToc: false,
  }));

  const options: any = {
    title: novel.title,
    author: [author],
    publisher: 'NovelForge',
    description: epubDescription(novel, author),
    version: 3,
    lang: 'en',
    prependChapterTitles: true,
  };
  if (settings.includeToc === 0 || settings.includeToc === false) {
    options.tocInTOC = false;
  }
  if (cover) {
    // epub-gen-memory accepts a File; Node 22 exposes File globally.
    options.cover = new File([new Uint8Array(cover.data)], `cover.${cover.ext}`, { type: cover.ext === 'png' ? 'image/png' : 'image/jpeg' });
  }

  const buffer = await Epub(options, content);
  return { buffer: Buffer.from(buffer), warnings };
}

/** Human-readable EPUB blurb; never the string "undefined novel". */
function epubDescription(novel: any, author: string) {
  const premise = typeof novel?.premise === 'string' ? novel.premise.trim() : '';
  if (premise) return premise.slice(0, 400);
  const genre = typeof novel?.genre === 'string' && novel.genre.trim() ? novel.genre.trim() : '';
  return (genre ? `A ${genre} novel by ${author}.` : `A novel by ${author}.`).slice(0, 400);
}

function htmlFromPlainText(text: string) {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escape(p)}</p>`)
    .join('\n');
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) <= maxWidth) current = test;
      else { if (current) lines.push(current); current = word; }
    }
    if (current) lines.push(current);
  }
  return lines;
}

export function listExports(novelId: string) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM exports WHERE novelId=? ORDER BY createdAt DESC').all(novelId) as any[];
  return rows.map(row => {
    let options: any = null;
    try { options = row.options ? JSON.parse(row.options) : null; } catch { options = null; }
    return { ...row, options };
  });
}
