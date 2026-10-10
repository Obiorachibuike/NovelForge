import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import { generateText, generateStructured } from '@/lib/ai/text-generation';
import { chapterPrompt, chapterSummaryPrompt } from '@/lib/ai/prompts';
import { embed, serialize } from '@/lib/ai/embeddings';
import { registerHandler } from '@/lib/queue';
import { countWords } from '@/types';
import { z } from 'zod';
import 'server-only';

export interface ChapterDoc { type:'doc'; content: any[] }

export function emptyDoc(text?: string): ChapterDoc {
  if (!text) return { type:'doc', content: [{ type:'paragraph', content: [] }] };
  const paragraphs = text.split(/\n{2,}/).map(p => ({
    type: 'paragraph',
    content: p.trim().length ? [{ type:'text', text: p.trim() }] : [],
  }));
  return { type:'doc', content: paragraphs.length ? paragraphs : [{ type:'paragraph', content: [] }] };
}

export function docToPlainText(doc: ChapterDoc | any): string {
  if (!doc || doc.type !== 'doc') return '';
  const out: string[] = [];
  const walk = (node:any) => {
    if (node.type === 'text') out.push(node.text || '');
    if (Array.isArray(node.content)) {
      for (const c of node.content) walk(c);
      if (node.type === 'paragraph' || node.type === 'heading') out.push('\n\n');
    }
  };
  walk(doc);
  return out.join('').replace(/\n{3,}/g,'\n\n').trim();
}

export function docToHtml(doc: ChapterDoc | any): string {
  if (!doc || doc.type !== 'doc') return '';
  return renderNode(doc);
}

function renderNode(node:any): string {
  if (node.type === 'text') {
    let t = (node.text || '').replace(/[&<>]/g, (c:string) => ({'&':'&amp;','<':'&lt;','>':'&gt;'} as Record<string,string>)[c] as string);
    if (node.marks) {
      for (const m of node.marks) {
        if (m.type === 'bold') t = `<strong>${t}</strong>`;
        else if (m.type === 'italic') t = `<em>${t}</em>`;
        else if (m.type === 'underline') t = `<u>${t}</u>`;
        else if (m.type === 'highlight') t = `<mark>${t}</mark>`;
        else if (m.type === 'link' && m.attrs?.href) t = `<a href="${m.attrs.href}" rel="nofollow noopener">${t}</a>`;
      }
    }
    return t;
  }
  const inner = Array.isArray(node.content) ? node.content.map(renderNode).join('') : '';
  switch (node.type) {
    case 'doc': return inner;
    case 'paragraph': return `<p>${inner}</p>`;
    case 'heading': return `<h${node.attrs?.level||2}>${inner}</h${node.attrs?.level||2}>`;
    case 'blockquote': return `<blockquote>${inner}</blockquote>`;
    case 'bulletList': return `<ul>${inner}</ul>`;
    case 'orderedList': return `<ol>${inner}</ol>`;
    case 'listItem': return `<li>${inner}</li>`;
    case 'hardBreak': return '<br/>';
    case 'horizontalRule': return '<hr/>';
    default: return inner;
  }
}

export async function enqueueChapterGeneration(userId: string, novelId: string, chapterNumber: number) {
  const { enqueue } = await import('@/lib/queue');
  // Lock check: find the first non-approved chapter; must equal chapterNumber.
  const db = getDb();
  const nextChapter = db.prepare(`SELECT chapterNumber FROM chapters WHERE novelId = ? AND status != 'approved' ORDER BY chapterNumber ASC LIMIT 1`).get(novelId) as any;
  const hasPending = !!db.prepare(`SELECT id FROM generation_jobs WHERE novelId = ? AND taskType='chapter' AND status IN ('queued','processing')`).get(novelId);
  if (hasPending) throw new Error('A chapter is already being generated.');
  if (nextChapter && nextChapter.chapterNumber !== chapterNumber) {
    throw new Error(`Chapter ${nextChapter.chapterNumber} must be approved before generating chapter ${chapterNumber}.`);
  }
  return enqueue({
    type:'chapter', userId, novelId, payload:{ chapterNumber },
    idempotencyKey:`chapter:${novelId}:${chapterNumber}`,
  });
}

async function runChapterGeneration({ novelId, userId, payload }: any) {
  const db = getDb();
  const chapterNumber = payload.chapterNumber;
  const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as any;
  if (!novel) throw new Error('Novel not found');

  // Find or create outline
  let outline = db.prepare('SELECT * FROM chapter_outlines WHERE novelId=? AND chapterNumber=?').get(novelId, chapterNumber) as any;
  if (!outline) throw new Error(`No outline for chapter ${chapterNumber}`);

  // Refuse to generate if previous chapter not approved (skip for ch 1)
  if (chapterNumber > 1) {
    const prev = db.prepare(`SELECT status FROM chapters WHERE novelId=? AND chapterNumber=?`).get(novelId, chapterNumber-1) as any;
    if (!prev || prev.status !== 'approved') throw new Error(`Previous chapter must be approved before generating chapter ${chapterNumber}.`);
  }

  // Check if chapter already exists and is approved
  const existing = db.prepare('SELECT id,status FROM chapters WHERE novelId=? AND chapterNumber=?').get(novelId, chapterNumber) as any;
  if (existing && existing.status === 'approved') throw new Error('Chapter is already approved.');

  // Build context
  const previousChapter = db.prepare(`SELECT summary,plainText FROM chapters WHERE novelId=? AND chapterNumber=? AND status='approved' ORDER BY chapterNumber DESC LIMIT 1`).get(novelId, chapterNumber-1) as any;
  const memories = db.prepare(`SELECT kind,content FROM chapter_memories WHERE novelId=? ORDER BY importance DESC LIMIT 12`).all(novelId) as any[];
  const premise = db.prepare('SELECT logline,shortSynopsis FROM premises WHERE novelId=?').get(novelId) as any;
  const characters = db.prepare('SELECT name,role,personality,arc FROM characters WHERE novelId=? LIMIT 8').all(novelId) as any[];

  const prompt = chapterPrompt(
    { novel, premise: premise ? { shortSynopsis: premise.shortSynopsis } : undefined, characters, memories, previousSummary: previousChapter?.summary } as any,
    { number: chapterNumber, title: outline.title, summary: outline.summary, targetWords: outline.targetWords,
      charactersInvolved: outline.charactersInvolved, location: outline.location, conflict: outline.conflict },
    previousChapter?.summary
  );

  const fallbackText = generateFallbackChapter(chapterNumber, outline.title);
  const prose = await generateText({
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0.85, maxTokens: Math.min(4500, Math.max(1500, Math.round(outline.targetWords * 1.6))),
    userId, novelId, taskType: 'chapter',
  }).catch(err => { console.warn('chapter generation failed, using fallback', err); return fallbackText; });

  const text = (prose || fallbackText).trim();
  const doc = emptyDoc(text);
  const html = docToHtml(doc);
  const plain = text;
  const words = countWords(plain);
  const pages = Math.max(1, Math.round(words / (outline.targetWords ? (outline.targetWords / Math.max(1, outline.estimatedPages||1)) : 320)));

  const now = new Date().toISOString();
  let chapterId = existing?.id;
  const tx = db.transaction(() => {
    if (chapterId) {
      db.prepare(`UPDATE chapters SET title=?, contentJson=?, contentHtml=?, plainText=?, wordCount=?, pageCountEst=?, status='generated', updatedAt=? WHERE id=?`)
        .run(outline.title, JSON.stringify(doc), html, plain, words, pages, now, chapterId);
    } else {
      chapterId = nanoid();
      db.prepare(`INSERT INTO chapters (id,novelId,outlineId,chapterNumber,title,contentJson,contentHtml,plainText,status,wordCount,pageCountEst,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          chapterId, novelId, outline.id, chapterNumber, outline.title,
          JSON.stringify(doc), html, plain, 'generated', words, pages, now, now);
    }
    // Initial version snapshot
    const versionNum = 1;
    db.prepare(`INSERT INTO chapter_versions (id,chapterId,versionNum,contentJson,wordCount,note,createdAt) VALUES (?,?,?,?,?,?,?)`)
      .run(nanoid(), chapterId, versionNum, JSON.stringify(doc), words, 'Initial generation', now);
    const vRow = db.prepare(`SELECT id FROM chapter_versions WHERE chapterId=? ORDER BY versionNum DESC LIMIT 1`).get(chapterId) as { id: string } | undefined;
    db.prepare(`UPDATE chapters SET currentVersionId=? WHERE id=?`).run(vRow?.id || null, chapterId);
    db.prepare(`UPDATE chapter_outlines SET status='writing' WHERE id=?`).run(outline.id);
  });
  tx();

  // After generation, asynchronously run summarisation (don't block the job completion but chain as a memory job)
  setImmediate(() => void summarizeChapter(chapterId!, userId).catch(e => console.warn('summarize failed', e)));
}

registerHandler('chapter', runChapterGeneration);

async function summarizeChapter(chapterId: string, userId: string) {
  const db = getDb();
  const chapter = db.prepare('SELECT * FROM chapters WHERE id=?').get(chapterId) as any;
  if (!chapter || !chapter.plainText) return;
  const novel = db.prepare('SELECT * FROM novels WHERE id=?').get(chapter.novelId) as any;
  const prompt = chapterSummaryPrompt(novel, { number: chapter.chapterNumber, title: chapter.title }, chapter.plainText);

  const summaryShape = z.object({
    summary: z.string(),
    importantEvents: z.array(z.string()).default([]),
    characterUpdates: z.array(z.object({ name:z.string(), newState:z.string() })).default([]),
    timelineUpdates: z.array(z.object({ label:z.string(), description:z.string(), when:z.string().optional() })).default([]),
    plotThreadUpdates: z.array(z.object({ title:z.string(), description:z.string(), status:z.string() })).default([]),
    worldRuleUpdates: z.array(z.object({ name:z.string(), description:z.string(), category:z.string().optional() })).default([]),
    foreshadowedPayoffs: z.array(z.string()).default([]),
  });
  const fallback = {
    summary: chapter.plainText.slice(0,400), importantEvents: chapter.title ? [`${chapter.title} takes place`] : [],
    characterUpdates: [], timelineUpdates: [], plotThreadUpdates: [], worldRuleUpdates: [], foreshadowedPayoffs: [],
  };
  const result = await generateStructured(summaryShape, {
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0.2, userId, novelId: novel.id, taskType: 'memory', fallback,
  });

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE chapters SET summary=?, importantEvents=?, updatedAt=? WHERE id=?`)
      .run(result.summary, JSON.stringify(result.importantEvents), now, chapterId);

    // Characters: if name matches, append arc/state; otherwise no-op
    for (const u of result.characterUpdates) {
      const ch = db.prepare(`SELECT id FROM characters WHERE novelId=? AND name=? LIMIT 1`).get(novel.id, u.name) as any;
      if (ch) {
        db.prepare(`UPDATE characters SET arc = COALESCE(arc,'') || CASE WHEN arc IS NOT NULL AND arc != '' THEN '\n' ELSE '' END || ?, updatedAt=? WHERE id=?`)
          .run(u.newState, now, ch.id);
      }
    }
    // Timeline
    for (const e of result.timelineUpdates) {
      db.prepare(`INSERT INTO timeline_events (id,novelId,chapterId,label,description,"when",orderIndex,createdAt) VALUES (?,?,?,?,?,?,?,?)`)
        .run(nanoid(), novel.id, chapterId, e.label, e.description, e.when || null, Date.now() % 1_000_000, now);
    }
    // Plot threads
    for (const t of result.plotThreadUpdates) {
      const existing = db.prepare(`SELECT id FROM plot_threads WHERE novelId=? AND title=? LIMIT 1`).get(novel.id, t.title) as any;
      if (existing) {
        db.prepare(`UPDATE plot_threads SET description=?, status=?, updatedAt=? WHERE id=?`)
          .run(t.description, ['open','progressing','resolved','new'].includes(t.status) ? t.status : 'progressing', now, existing.id);
      } else {
        db.prepare(`INSERT INTO plot_threads (id,novelId,title,description,status,introducedInChapterId,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)`)
          .run(nanoid(), novel.id, t.title, t.description, t.status === 'new' ? 'open' : t.status, chapterId, now, now);
      }
    }
    // World rules
    for (const r of result.worldRuleUpdates) {
      const exists = db.prepare(`SELECT id FROM world_rules WHERE novelId=? AND name=? LIMIT 1`).get(novel.id, r.name) as any;
      if (!exists) db.prepare(`INSERT INTO world_rules (id,novelId,name,description,category,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`)
        .run(nanoid(), novel.id, r.name, r.description, r.category || 'world', now, now);
    }
    // Write chapter summary and events as memories
    const memIns = db.prepare(`INSERT INTO chapter_memories (id,novelId,chapterId,kind,content,importance,embedding,createdAt) VALUES (?,?,?,?,?,?,?,?)`);
    memIns.run(nanoid(), novel.id, chapterId, 'summary', result.summary, 3, null, now);
    for (const e of result.importantEvents) memIns.run(nanoid(), novel.id, chapterId, 'event', e, 2, null, now);
    for (const u of result.characterUpdates) memIns.run(nanoid(), novel.id, chapterId, 'character', `${u.name}: ${u.newState}`, 2, null, now);
    for (const f of result.foreshadowedPayoffs) memIns.run(nanoid(), novel.id, chapterId, 'thread', `Foreshadowed: ${f}`, 2, null, now);
  });
  tx();

  // Embed the summary async
  try {
    const vec = await embed(result.summary, userId, novel.id);
    db.prepare(`UPDATE chapter_memories SET embedding=? WHERE chapterId=? AND kind='summary' ORDER BY createdAt DESC LIMIT 1`)
      .run(serialize(vec), chapterId);
  } catch (e) { console.warn('summary embedding failed', e); }
}

export async function saveChapterContent(userId: string, novelId: string, chapterId: string, doc: { type?: string; content?: any[] }) {
  const db = getDb();
  const novel = db.prepare('SELECT * FROM novels WHERE id=? AND userId=?').get(novelId, userId) as any;
  if (!novel) throw new Error('Novel not found');
  const chapter = db.prepare('SELECT * FROM chapters WHERE id=? AND novelId=?').get(chapterId, novelId) as any;
  if (!chapter) throw new Error('Chapter not found');
  if (chapter.status === 'approved') throw new Error('Approved chapters cannot be edited directly; create a new version.');
  const fullDoc: ChapterDoc = { type: 'doc', content: Array.isArray(doc.content) ? doc.content : [] };
  const plain = docToPlainText(fullDoc);
  const html = docToHtml(fullDoc);
  const words = countWords(plain);
  const wpp = 320;
  const pages = Math.max(1, Math.round(words/wpp));
  const now = new Date().toISOString();
  db.prepare(`UPDATE chapters SET contentJson=?, contentHtml=?, plainText=?, wordCount=?, pageCountEst=?, status=CASE WHEN status='generated' THEN 'edited' ELSE status END, updatedAt=? WHERE id=?`)
    .run(JSON.stringify(fullDoc), html, plain, words, pages, now, chapterId);
  return { wordCount: words, pages };
}

export async function createVersion(userId: string, novelId: string, chapterId: string, note?: string) {
  const db = getDb();
  const chapter = db.prepare('SELECT * FROM chapters WHERE id=? AND novelId=? AND EXISTS(SELECT 1 FROM novels WHERE id=? AND userId=?)').get(chapterId, novelId, novelId, userId) as any;
  if (!chapter) throw new Error('Chapter not found');
  const current = db.prepare(`SELECT COALESCE(MAX(versionNum),0)+1 AS next FROM chapter_versions WHERE chapterId=?`).get(chapterId) as any;
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO chapter_versions (id,chapterId,versionNum,contentJson,wordCount,note,createdAt) VALUES (?,?,?,?,?,?,?)`)
    .run(id, chapterId, current.next, chapter.contentJson, chapter.wordCount, note || null, now);
  db.prepare(`UPDATE chapters SET currentVersionId=?, updatedAt=? WHERE id=?`).run(id, now, chapterId);
  return { versionNum: current.next };
}

export async function approveChapter(userId: string, novelId: string, chapterId: string) {
  const db = getDb();
  const chapter = db.prepare('SELECT * FROM chapters WHERE id=? AND novelId=? AND EXISTS(SELECT 1 FROM novels WHERE id=? AND userId=?)').get(chapterId, novelId, novelId, userId) as any;
  if (!chapter) throw new Error('Chapter not found');
  if (chapter.status === 'approved') return chapter;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE chapters SET status='approved', approvedAt=COALESCE(approvedAt, ?), updatedAt=? WHERE id=?`).run(now, now, chapterId);
    db.prepare(`UPDATE chapter_outlines SET status='approved' WHERE id=?`).run(chapter.outlineId);
    // Update novel progress & stage
    const stats = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS done FROM chapters WHERE novelId=?`).get(novelId) as any;
    const totalOutlines = db.prepare(`SELECT COUNT(*) AS c FROM chapter_outlines WHERE novelId=?`).get(novelId) as any;
    if (stats.done >= totalOutlines.c && totalOutlines.c > 0) {
      db.prepare(`UPDATE novels SET status='completed', stage='export', completedAt=?, updatedAt=? WHERE id=?`).run(now, now, novelId);
    }
  });
  tx();
  // Run summarisation/consistency if it hasn't happened yet
  if (!chapter.summary) setImmediate(() => void summarizeChapter(chapterId, userId).catch(e => console.warn('post-approve summary failed', e)));
  return chapter;
}

export async function getChapter(novelId: string, chapterId: string) {
  const db = getDb();
  return db.prepare(`SELECT c.*, o.targetWords, o.estimatedPages AS targetPages, o.summary AS outlineSummary
    FROM chapters c LEFT JOIN chapter_outlines o ON o.id = c.outlineId
    WHERE c.id=? AND c.novelId=?`).get(chapterId, novelId) as any;
}

export async function getChapterByNumber(novelId: string, n: number) {
  const db = getDb();
  return db.prepare(`SELECT * FROM chapters WHERE novelId=? AND chapterNumber=?`).get(novelId, n) as any;
}

export async function listChapters(novelId: string) {
  const db = getDb();
  return db.prepare(`SELECT c.*, o.targetWords, o.estimatedPages AS targetPages, o.title AS outlineTitle
    FROM chapters c LEFT JOIN chapter_outlines o ON o.chapterNumber = c.chapterNumber AND o.novelId = c.novelId
    WHERE c.novelId=? ORDER BY c.chapterNumber ASC`).all(novelId) as any[];
}

export async function getNavigation(novelId: string) {
  const db = getDb();
  const outlines = db.prepare(`SELECT chapterNumber, title, targetWords, estimatedPages, status AS outlineStatus FROM chapter_outlines WHERE novelId=? ORDER BY chapterNumber`).all(novelId) as any[];
  const chapters = db.prepare(`SELECT id, chapterNumber, title, status, wordCount, pageCountEst FROM chapters WHERE novelId=? ORDER BY chapterNumber`).all(novelId) as any[];
  const byNum = new Map(chapters.map(c => [c.chapterNumber, c]));
  // Determine "locked" state of each chapter: it's locked if there exists a prior chapter not approved.
  let lastApproved = 0;
  const nav = outlines.map(o => {
    const c = byNum.get(o.chapterNumber);
    const isNext = !c && lastApproved === o.chapterNumber - 1;
    const isLocked = !(o.chapterNumber === 1) && lastApproved < o.chapterNumber - 1;
    if (c?.status === 'approved') lastApproved = o.chapterNumber;
    return {
      chapterNumber: o.chapterNumber, title: o.title, targetWords: o.targetWords, targetPages: o.estimatedPages,
      status: c?.status || (isLocked ? 'locked' : (isNext ? 'next' : 'planned')),
      chapterId: c?.id || null, wordCount: c?.wordCount || 0, pageCountEst: c?.pageCountEst || 0,
    };
  });
  // Recompute locks in a second pass because the first pass may advance early
  let seenApproved = 0;
  for (const n of nav) {
    if (n.status === 'locked') continue;
    if (seenApproved < n.chapterNumber - 1 && n.chapterNumber !== 1) n.status = 'locked';
    if (n.status === 'approved') seenApproved = n.chapterNumber;
  }
  return nav;
}

export async function listVersions(chapterId: string) {
  const db = getDb();
  return db.prepare(`SELECT * FROM chapter_versions WHERE chapterId=? ORDER BY versionNum DESC`).all(chapterId) as any[];
}

export async function restoreVersion(userId: string, novelId: string, chapterId: string, versionId: string) {
  const db = getDb();
  const v = db.prepare(`SELECT * FROM chapter_versions WHERE id=? AND chapterId=?`).get(versionId, chapterId) as any;
  if (!v) throw new Error('Version not found');
  // create a new version capturing current state, then restore content
  await createVersion(userId, novelId, chapterId, 'Auto-save before restore');
  const now = new Date().toISOString();
  const plain = docToPlainText(JSON.parse(v.contentJson));
  const words = countWords(plain);
  db.prepare(`UPDATE chapters SET contentJson=?, plainText=?, contentHtml=?, wordCount=?, pageCountEst=?, updatedAt=? WHERE id=? AND novelId=? AND EXISTS(SELECT 1 FROM novels WHERE id=? AND userId=?)`)
    .run(v.contentJson, plain, docToHtml(JSON.parse(v.contentJson)), words, Math.max(1,Math.round(words/320)), now, chapterId, novelId, novelId, userId);
}

function generateFallbackChapter(n: number, title: string) {
  return [
    `The rain had stopped by the time Kael reached the old quarter, but the stones still glistened like old wounds.`,
    `He moved through his own city like a ghost wearing someone else's face. Twelve years had softened the edges of his memory, but not the shape of the towers. Veyra still rose around him in layers of pale stone and smoked glass, catching the last light of evening in their windows.`,
    `At the end of the alley a single lamp burned above a door with no sign. The mark on the letter was a circle split by a vertical line—the symbol of the Ashen Pact. He had expected dust, ruin. Instead, the door opened before he could knock.`,
    `"You took your time," said the woman inside.`,
    `Kael stepped across the threshold. "I was told the dead were patient."`,
    `"The dead are patient. I am not." Seren Vale turned, and for one impossible second he saw the girl who used to steal apples from the palace kitchens. Then the years settled back over her face. She was older, sharper, and in her eyes there was the same unforgiving intelligence he remembered — the one thing the Glass City had not managed to polish away.`,
    `"Chapter ${n}: ${title}," she said, as if naming a sentence. "You're late."`,
  ].join('\n\n');
}
