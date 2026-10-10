import { getDb } from '@/lib/db';
import { saveFile } from '@/lib/storage';
import { getOpenAI, aiConfig } from '@/lib/ai/provider';
import { nanoid } from 'nanoid';
import { coverPrompt } from '@/lib/ai/prompts';
import 'server-only';

export interface GeneratedCover { imageId: string; url: string; }

/** Generate cover concepts. In demo mode (no OpenAI key) we generate stylized SVG covers. */
export async function generateCovers(userId: string, novelId: string, promptOverride?: string, variants = 2): Promise<GeneratedCover[]> {
  const db = getDb();
  const novel = db.prepare('SELECT * FROM novels WHERE id = ? AND userId = ?').get(novelId, userId) as any;
  if (!novel) throw new Error('Novel not found');
  const results: GeneratedCover[] = [];

  for (let i = 0; i < variants; i++) {
    let buf: Buffer;
    let provider = 'openai';
    let width = 768, height = 1024;
    const client = getOpenAI();
    if (client && aiConfig.imageModel && !aiConfig.demoMode) {
      try {
        const resp = await client.images.generate({
          model: aiConfig.imageModel,
          prompt: promptOverride || coverPrompt(novel, 'cinematic hardcover'),
          n: 1, size: '1024x1792', quality: 'standard',
        });
        const url = resp.data?.[0]?.url;
        if (url) {
          const img = await fetch(url);
          const arr = await img.arrayBuffer();
          buf = Buffer.from(arr);
          const stored = await saveFile({ data: buf, folder: 'covers', ext: 'png' });
          const id = await saveImageRecord(db, { userId, novelId, url: stored.url, key: stored.key, width: 1024, height: 1792, prompt: promptOverride || coverPrompt(novel), provider });
          results.push({ imageId: id, url: stored.url });
          continue;
        }
      } catch (e) {
        console.warn('OpenAI image generation failed, falling back to SVG cover', e);
      }
    }
    // Demo / fallback: stylized SVG cover
    buf = makeSvgCover(novel, i);
    provider = 'demo-svg';
    const stored = await saveFile({ data: buf, folder: 'covers', ext: 'svg' });
    const id = await saveImageRecord(db, { userId, novelId, url: stored.url, key: stored.key, width, height, prompt: promptOverride || coverPrompt(novel), provider });
    results.push({ imageId: id, url: stored.url });
  }
  return results;
}

function saveImageRecord(db: any, { userId, novelId, url, key, width, height, prompt, provider }:{
  userId:string; novelId:string; url:string; key:string; width:number; height:number; prompt:string; provider:string;
}) {
  const id = nanoid();
  db.prepare(
    `INSERT INTO image_assets (id,novelId,userId,kind,provider,storageKey,url,width,height,prompt,isPrimary,meta,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, novelId, userId, 'cover', provider, key, url, width, height, prompt, 0, null, new Date().toISOString());
  return id;
}

/** Generates a stylized hardcover SVG with title and gradient art. */
export function makeSvgCover(novel: { title:string; genre?:string; tone?:string }, variant = 0) {
  const palettes = [
    { from:'#2a1f47', to:'#4a2d5c', accent:'#f3ecd9', glow:'rgba(232,192,122,.35)' },
    { from:'#1c2a47', to:'#2d4570', accent:'#e8e4ff', glow:'rgba(167,139,250,.4)' },
    { from:'#3a1f2a', to:'#702d45', accent:'#ffe4c4', glow:'rgba(245,198,231,.35)' },
    { from:'#1f2e1c', to:'#365c3a', accent:'#f0e6c4', glow:'rgba(232,192,122,.3)' },
  ];
  const p = palettes[variant % palettes.length];
  const titleLines = wrap(novel.title || 'Untitled', 12);
  const titleSvg = titleLines.map((line, i) => `<text x="50%" y="${340 + i*88}" text-anchor="middle" fill="${p.accent}" font-family="Georgia, 'Playfair Display', serif" font-size="72" font-weight="700">${escapeXml(line)}</text>`).join('');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024" viewBox="0 0 768 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${p.from}"/>
      <stop offset="1" stop-color="${p.to}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="30%" r="70%">
      <stop offset="0" stop-color="${p.glow}"/>
      <stop offset="1" stop-color="transparent"/>
    </radialGradient>
  </defs>
  <rect width="768" height="1024" fill="url(#bg)"/>
  <rect width="768" height="1024" fill="url(#glow)"/>
  <rect x="36" y="36" width="696" height="952" fill="none" stroke="${p.accent}" stroke-opacity=".25" stroke-width="2"/>
  <text x="50%" y="160" text-anchor="middle" fill="${p.accent}" font-family="ui-monospace, Menlo, monospace" font-size="24" letter-spacing="8" opacity=".85">THE</text>
  ${titleSvg}
  <text x="50%" y="${340 + titleLines.length*88 + 20}" text-anchor="middle" fill="${p.accent}" font-size="42" opacity=".7">✦</text>
  <text x="50%" y="860" text-anchor="middle" fill="${p.accent}" font-family="ui-monospace, Menlo, monospace" font-size="20" letter-spacing="6" opacity=".8">A NOVEL OF ASH &amp; OATHS</text>
</svg>`;
  return Buffer.from(svg);
}

function wrap(text: string, width: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur+' '+w).trim().length > width) {
      if (cur) lines.push(cur.trim());
      cur = w;
    } else {
      cur = (cur+' '+w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0,4);
}

function escapeXml(s: string) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function listCovers(novelId: string) {
  const db = getDb();
  return db.prepare('SELECT * FROM image_assets WHERE novelId = ? AND kind = ? ORDER BY isPrimary DESC, createdAt DESC').all(novelId, 'cover') as any[];
}
