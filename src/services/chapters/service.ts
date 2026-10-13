import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import { generateTextDetailed, generateStructuredDetailed } from '@/lib/ai/text-generation';
import { chapterPrompt, chapterSummaryPrompt } from '@/lib/ai/prompts';
import { embed, serialize, deserialize } from '@/lib/ai/embeddings';
import { registerHandler } from '@/lib/queue';
import { retrieveMemories } from '@/services/memory/service';
import { getSettings } from '@/services/novels/service';
import { HttpError } from '@/lib/api/http';
import { computeNavigation, nextWritableChapter, type ChapterNav } from '@/lib/workflow/navigation';
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

/**
 * Queues generation for one chapter.
 *
 * Refusals (all before any paid provider call or job row):
 *  - the novel must belong to the caller;
 *  - the chapter must be the next unapproved one in the outline order;
 *  - an approved chapter can never be regenerated;
 *  - a chapter containing the author's own edits can only be regenerated when
 *    `confirmOverwrite` is passed, so autosaved prose is never silently lost.
 */
export async function enqueueChapterGeneration(
  userId: string,
  novelId: string,
  chapterNumber: number,
  options: { confirmOverwrite?: boolean } = {},
) {
  const db = getDb();
  const novel = db.prepare('SELECT id FROM novels WHERE id = ? AND userId = ?').get(novelId, userId);
  if (!novel) throw new HttpError(404, 'Novel not found', 'novel_not_found');

  const outlines = db.prepare('SELECT chapterNumber FROM chapter_outlines WHERE novelId = ? ORDER BY chapterNumber').all(novelId) as { chapterNumber: number }[];
  if (!outlines.length) throw new HttpError(409, 'Generate and approve an outline before writing chapters.', 'no_outline');
  if (!outlines.some(o => o.chapterNumber === chapterNumber)) {
    throw new HttpError(404, `Chapter ${chapterNumber} is not part of this outline.`, 'unknown_chapter');
  }

  const chapters = db.prepare('SELECT id,chapterNumber,status FROM chapters WHERE novelId = ?').all(novelId) as { id:string; chapterNumber:number; status:string }[];
  const nav = computeNavigation(outlines, chapters.map(c => ({ ...c, status: c.status })));
  const writable = nextWritableChapter(nav);
  if (writable !== chapterNumber) {
    const blocking = nav.find(n => n.chapterNumber === writable);
    throw new HttpError(
      409,
      blocking && blocking.chapterNumber !== chapterNumber
        ? `Chapter ${blocking.chapterNumber} must be approved before generating chapter ${chapterNumber}.`
        : `Chapter ${chapterNumber} cannot be generated right now.`,
      'chapter_locked',
    );
  }

  const existing = chapters.find(c => c.chapterNumber === chapterNumber);
  if (existing?.status === 'approved') {
    throw new HttpError(409, 'This chapter is already approved.', 'chapter_approved');
  }
  if (existing && existing.status === 'edited' && !options.confirmOverwrite) {
    throw new HttpError(
      409,
      'This chapter contains your own edits. Regenerating will replace them.',
      'overwrite_confirmation_required',
    );
  }

  const { enqueue } = await import('@/lib/queue');
  return enqueue({
    type: 'chapter',
    userId,
    novelId,
    payload: { chapterNumber, confirmOverwrite: !!options.confirmOverwrite },
    idempotencyKey: `chapter:${novelId}:${chapterNumber}`,
  });
}

interface ChapterJobPayload { chapterNumber: number; confirmOverwrite?: boolean }

async function runChapterGeneration({ novelId, userId, payload, setProgress }: any) {
  const db = getDb();
  const { chapterNumber, confirmOverwrite } = payload as ChapterJobPayload;
  const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as any;
  if (!novel) throw new Error('Novel not found');

  const outline = db.prepare('SELECT * FROM chapter_outlines WHERE novelId=? AND chapterNumber=?').get(novelId, chapterNumber) as any;
  if (!outline) throw new Error(`No outline for chapter ${chapterNumber}`);

  // Re-check the gate inside the worker: the outline or approvals may have
  // changed between enqueue and execution.
  if (chapterNumber > 1) {
    const prev = db.prepare(`SELECT status FROM chapters WHERE novelId=? AND chapterNumber=?`).get(novelId, chapterNumber - 1) as any;
    if (!prev || prev.status !== 'approved') throw new Error(`Previous chapter must be approved before generating chapter ${chapterNumber}.`);
  }

  const existing = db.prepare('SELECT id,status FROM chapters WHERE novelId=? AND chapterNumber=?').get(novelId, chapterNumber) as any;
  if (existing && existing.status === 'approved') throw new Error('Chapter is already approved.');
  if (existing && existing.status === 'edited' && !confirmOverwrite) {
    throw new Error('Chapter has author edits; regeneration needs explicit confirmation.');
  }

  setProgress?.(10);

  const settings = getSettings(novelId) as any;
  const wordsPerPage = settings?.wordsPerPage || 320;

  const previousChapter = db.prepare(
    `SELECT summary FROM chapters WHERE novelId=? AND chapterNumber=? AND status='approved' ORDER BY chapterNumber DESC LIMIT 1`,
  ).get(novelId, chapterNumber - 1) as any;
  const premise = db.prepare('SELECT logline,shortSynopsis FROM premises WHERE novelId=?').get(novelId) as any;
  const characters = db.prepare('SELECT name,role,personality,arc FROM characters WHERE novelId=? LIMIT 8').all(novelId) as any[];

  // Retrieval-augmented context: score stored memories against this chapter's
  // outline instead of shipping an arbitrary slice of the memory table.
  let memories: Array<{ kind: string; content: string }> = [];
  try {
    const query = [outline.title, outline.summary, outline.charactersInvolved, outline.conflict].filter(Boolean).join(' ');
    memories = await retrieveMemories(novelId, query || outline.title || '', userId, 8);
  } catch (err) {
    console.warn('[chapters] memory retrieval failed, continuing without it:', err);
  }

  setProgress?.(25);

  const prompt = chapterPrompt(
    { novel, premise: premise ? { shortSynopsis: premise.shortSynopsis } : undefined, characters, memories, previousSummary: previousChapter?.summary } as any,
    { number: chapterNumber, title: outline.title, summary: outline.summary, targetWords: outline.targetWords,
      charactersInvolved: outline.charactersInvolved, location: outline.location, conflict: outline.conflict },
    previousChapter?.summary
  );

  // No silent fabrication: in demo mode the caller gets clearly-labelled demo
  // prose; if a real provider call fails the job fails and retries instead of
  // saving mock text as if it were generated.
  const generated = await generateTextDetailed({
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0.85,
    maxTokens: Math.min(4500, Math.max(1500, Math.round(outline.targetWords * 1.6))),
    userId, novelId, taskType: 'chapter',
    allowFallbackOnError: false,
  });
  if (!generated.text.trim()) throw new Error('Provider returned an empty chapter.');

  setProgress?.(70);

  const text = generated.text.trim();
  const doc = emptyDoc(text);
  const html = docToHtml(doc);
  const words = countWords(text);
  const pages = Math.max(1, Math.round(words / wordsPerPage));

  const now = new Date().toISOString();
  let chapterId = existing?.id as string | undefined;
  const tx = db.transaction(() => {
    if (chapterId) {
      db.prepare(
        `UPDATE chapters SET title=?, contentJson=?, contentHtml=?, plainText=?, wordCount=?, pageCountEst=?,
                             status='generated', generationSource=?, generatedAt=?, summary=NULL, updatedAt=? WHERE id=?`,
      ).run(outline.title, JSON.stringify(doc), html, text, words, pages, generated.meta.source, now, now, chapterId);
    } else {
      chapterId = nanoid();
      db.prepare(
        `INSERT INTO chapters (id,novelId,outlineId,chapterNumber,title,contentJson,contentHtml,plainText,status,wordCount,pageCountEst,generationSource,generatedAt,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(chapterId, novelId, outline.id, chapterNumber, outline.title,
        JSON.stringify(doc), html, text, 'generated', words, pages, generated.meta.source, now, now, now);
    }

    const nextVersion = (db.prepare(`SELECT COALESCE(MAX(versionNum),0)+1 AS next FROM chapter_versions WHERE chapterId=?`)
      .get(chapterId) as { next: number }).next;
    const versionId = nanoid();
    db.prepare(`INSERT INTO chapter_versions (id,chapterId,versionNum,contentJson,wordCount,note,createdAt) VALUES (?,?,?,?,?,?,?)`)
      .run(versionId, chapterId, nextVersion, JSON.stringify(doc), words, `Generation (${generated.meta.source})`, now);
    db.prepare(`UPDATE chapters SET currentVersionId=? WHERE id=?`).run(versionId, chapterId);
    db.prepare(`UPDATE chapter_outlines SET status='writing' WHERE id=?`).run(outline.id);
  });
  tx();

  setProgress?.(90);

  // Durable follow-up: extraction is its own job so it survives a restart and
  // is retried on failure, instead of being a fire-and-forget setImmediate.
  await enqueueMemoryExtraction(userId, novelId, chapterId!);

  return {
    chapterId,
    chapterNumber,
    wordCount: words,
    source: generated.meta.source,
    demo: generated.meta.source === 'demo',
  };
}

registerHandler('chapter', runChapterGeneration);

/** Queues story-memory extraction for an approved chapter (durable + retried). */
export async function enqueueMemoryExtraction(userId: string, novelId: string, chapterId: string) {
  const { enqueue } = await import('@/lib/queue');
  return enqueue({
    type: 'memory',
    userId,
    novelId,
    payload: { chapterId },
    idempotencyKey: `memory:${chapterId}`,
  });
}

const summaryShape = z.object({
  summary: z.string(),
  importantEvents: z.array(z.string()).default([]),
  characterUpdates: z.array(z.object({ name:z.string(), newState:z.string() })).default([]),
  timelineUpdates: z.array(z.object({ label:z.string(), description:z.string(), when:z.string().optional() })).default([]),
  plotThreadUpdates: z.array(z.object({ title:z.string(), description:z.string(), status:z.string() })).default([]),
  worldRuleUpdates: z.array(z.object({ name:z.string(), description:z.string(), category:z.string().optional() })).default([]),
  foreshadowedPayoffs: z.array(z.string()).default([]),
});
type SummaryResult = z.infer<typeof summaryShape>;

/**
 * Extracts summary, events, character/thread/world updates from a chapter and
 * writes them to story memory. Runs as the `memory` job so it is retried and
 * observable. It never edits the manuscript: the author's prose is untouched.
 */
async function runMemoryExtraction({ novelId, userId, payload }: any) {
  const db = getDb();
  const chapterId: string = payload.chapterId;
  const chapter = db.prepare('SELECT * FROM chapters WHERE id=? AND novelId=?').get(chapterId, novelId) as any;
  if (!chapter) throw new Error('Chapter not found');
  if (!chapter.plainText) return { skipped: 'empty chapter' };

  const novel = db.prepare('SELECT * FROM novels WHERE id=?').get(novelId) as any;
  const prompt = chapterSummaryPrompt(novel, { number: chapter.chapterNumber, title: chapter.title }, chapter.plainText);
  const fallback: SummaryResult = {
    summary: chapter.plainText.slice(0, 400),
    importantEvents: chapter.title ? [`${chapter.title} takes place`] : [],
    characterUpdates: [], timelineUpdates: [], plotThreadUpdates: [], worldRuleUpdates: [], foreshadowedPayoffs: [],
  };
  const { data: result, meta } = await generateStructuredDetailed(summaryShape, {
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0.2, userId, novelId: novel.id, taskType: 'memory', fallback,
  });

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE chapters SET summary=?, importantEvents=?, updatedAt=? WHERE id=?`)
      .run(result.summary, JSON.stringify(result.importantEvents), now, chapterId);

    for (const u of result.characterUpdates) {
      const ch = db.prepare(`SELECT id FROM characters WHERE novelId=? AND name=? LIMIT 1`).get(novelId, u.name) as any;
      if (ch) {
        db.prepare(`UPDATE characters SET arc = COALESCE(arc,'') || CASE WHEN arc IS NOT NULL AND arc != '' THEN '\n' ELSE '' END || ?, updatedAt=? WHERE id=?`)
          .run(u.newState, now, ch.id);
      }
    }
    for (const e of result.timelineUpdates) {
      const maxOrder = (db.prepare('SELECT COALESCE(MAX(orderIndex),0)+1 AS next FROM timeline_events WHERE novelId=?').get(novelId) as any).next;
      db.prepare(`INSERT INTO timeline_events (id,novelId,chapterId,label,description,"when",orderIndex,createdAt) VALUES (?,?,?,?,?,?,?,?)`)
        .run(nanoid(), novelId, chapterId, e.label, e.description, e.when || null, maxOrder, now);
    }
    for (const t of result.plotThreadUpdates) {
      const thread = db.prepare(`SELECT id FROM plot_threads WHERE novelId=? AND title=? LIMIT 1`).get(novelId, t.title) as any;
      if (thread) {
        db.prepare(`UPDATE plot_threads SET description=?, status=?, updatedAt=? WHERE id=?`)
          .run(t.description, ['open','progressing','resolved','new'].includes(t.status) ? t.status : 'progressing', now, thread.id);
      } else {
        db.prepare(`INSERT INTO plot_threads (id,novelId,title,description,status,introducedInChapterId,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)`)
          .run(nanoid(), novelId, t.title, t.description, t.status === 'new' ? 'open' : t.status, chapterId, now, now);
      }
    }
    for (const r of result.worldRuleUpdates) {
      const exists = db.prepare(`SELECT id FROM world_rules WHERE novelId=? AND name=? LIMIT 1`).get(novelId, r.name) as any;
      if (!exists) db.prepare(`INSERT INTO world_rules (id,novelId,name,description,category,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`)
        .run(nanoid(), novelId, r.name, r.description, r.category || 'world', now, now);
    }

    // Replace this chapter's derived memories so re-runs do not duplicate them.
    db.prepare(`DELETE FROM chapter_memories WHERE chapterId=? AND kind IN ('summary','event','character','thread')`).run(chapterId);
    const memIns = db.prepare(`INSERT INTO chapter_memories (id,novelId,chapterId,kind,content,importance,embedding,createdAt) VALUES (?,?,?,?,?,?,?,?)`);
    const summaryMemoryId = nanoid();
    memIns.run(summaryMemoryId, novelId, chapterId, 'summary', result.summary, 3, null, now);
    for (const e of result.importantEvents) memIns.run(nanoid(), novelId, chapterId, 'event', e, 2, null, now);
    for (const u of result.characterUpdates) memIns.run(nanoid(), novelId, chapterId, 'character', `${u.name}: ${u.newState}`, 2, null, now);
    for (const f of result.foreshadowedPayoffs) memIns.run(nanoid(), novelId, chapterId, 'thread', `Foreshadowed: ${f}`, 2, null, now);
    return summaryMemoryId;
  });
  const summaryMemoryId = tx();

  // Embed by primary key (portable - no UPDATE ... ORDER BY ... LIMIT).
  try {
    const vec = await embed(result.summary, userId, novelId);
    db.prepare(`UPDATE chapter_memories SET embedding=? WHERE id=?`).run(serialize(vec), summaryMemoryId);
  } catch (e) {
    console.warn('[chapters] summary embedding failed (retrieval will fall back to keywords):', e);
  }

  return { source: meta.source, usedFallback: meta.usedFallback, importantEvents: result.importantEvents.length };
}

registerHandler('memory', runMemoryExtraction);

/** Kept for backwards compatibility with earlier call sites/tests. */
export async function summarizeChapter(chapterId: string, userId: string, novelId?: string) {
  const db = getDb();
  const chapter = db.prepare('SELECT novelId FROM chapters WHERE id=?').get(chapterId) as any;
  if (!chapter) throw new Error('Chapter not found');
  return runMemoryExtraction({ payload: { chapterId }, userId, novelId: novelId || chapter.novelId });
}

export async function saveChapterContent(userId: string, novelId: string, chapterId: string, doc: { type?: string; content?: any[] }) {
  const db = getDb();
  const novel = db.prepare('SELECT * FROM novels WHERE id=? AND userId=?').get(novelId, userId) as any;
  if (!novel) throw new HttpError(404, 'Novel not found', 'novel_not_found');
  const chapter = db.prepare('SELECT * FROM chapters WHERE id=? AND novelId=?').get(chapterId, novelId) as any;
  if (!chapter) throw new HttpError(404, 'Chapter not found', 'chapter_not_found');
  if (chapter.status === 'approved') {
    throw new HttpError(409, 'Approved chapters are read-only. Reopen the chapter to edit it.', 'chapter_approved');
  }
  const fullDoc: ChapterDoc = { type: 'doc', content: Array.isArray(doc.content) ? doc.content : [] };
  const plain = docToPlainText(fullDoc);
  const html = docToHtml(fullDoc);
  const words = countWords(plain);
  const settings = getSettings(novelId) as any;
  const pages = Math.max(1, Math.round(words / (settings?.wordsPerPage || 320)));
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE chapters SET contentJson=?, contentHtml=?, plainText=?, wordCount=?, pageCountEst=?,
                         status=CASE WHEN status='generated' THEN 'edited' ELSE status END, updatedAt=? WHERE id=?`,
  ).run(JSON.stringify(fullDoc), html, plain, words, pages, now, chapterId);
  return { wordCount: words, pages };
}

export async function createVersion(userId: string, novelId: string, chapterId: string, note?: string) {
  const db = getDb();
  const chapter = db.prepare(
    `SELECT c.* FROM chapters c JOIN novels n ON n.id=c.novelId WHERE c.id=? AND c.novelId=? AND n.userId=?`,
  ).get(chapterId, novelId, userId) as any;
  if (!chapter) throw new HttpError(404, 'Chapter not found', 'chapter_not_found');
  const current = db.prepare(`SELECT COALESCE(MAX(versionNum),0)+1 AS next FROM chapter_versions WHERE chapterId=?`).get(chapterId) as any;
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO chapter_versions (id,chapterId,versionNum,contentJson,wordCount,note,createdAt) VALUES (?,?,?,?,?,?,?)`)
    .run(id, chapterId, current.next, chapter.contentJson, chapter.wordCount, note || null, now);
  db.prepare(`UPDATE chapters SET currentVersionId=?, updatedAt=? WHERE id=?`).run(id, now, chapterId);
  return { versionNum: current.next };
}

/**
 * Approves a chapter and unlocks the next one.
 *
 * Approval never rewrites prose; it records the approval and queues the memory
 * extraction job so the Story Bible and story memory learn from the chapter.
 */
export async function approveChapter(userId: string, novelId: string, chapterId: string) {
  const db = getDb();
  const chapter = db.prepare(
    `SELECT c.* FROM chapters c JOIN novels n ON n.id=c.novelId WHERE c.id=? AND c.novelId=? AND n.userId=?`,
  ).get(chapterId, novelId, userId) as any;
  if (!chapter) throw new HttpError(404, 'Chapter not found', 'chapter_not_found');
  if (!chapter.plainText || countWords(chapter.plainText) < 1) {
    throw new HttpError(409, 'This chapter is empty and cannot be approved.', 'chapter_empty');
  }
  if (chapter.status === 'approved') return chapter;

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE chapters SET status='approved', approvedAt=COALESCE(approvedAt, ?), updatedAt=? WHERE id=?`).run(now, now, chapterId);
    if (chapter.outlineId) db.prepare(`UPDATE chapter_outlines SET status='approved' WHERE id=?`).run(chapter.outlineId);
    const stats = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS done FROM chapters WHERE novelId=?`).get(novelId) as any;
    const totalOutlines = db.prepare(`SELECT COUNT(*) AS c FROM chapter_outlines WHERE novelId=?`).get(novelId) as any;
    if (stats.done >= totalOutlines.c && totalOutlines.c > 0) {
      db.prepare(`UPDATE novels SET status='completed', stage='export', completedAt=?, updatedAt=? WHERE id=?`).run(now, now, novelId);
    }
  });
  tx();

  await enqueueMemoryExtraction(userId, novelId, chapterId);
  return { ...chapter, status: 'approved', approvedAt: now };
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

/**
 * Navigation for the writing workspace. Uses the shared gate implementation so
 * the server and the outline editor can never disagree about what is locked.
 */
export async function getNavigation(novelId: string): Promise<ChapterNav[]> {
  const db = getDb();
  const outlines = db.prepare(`SELECT chapterNumber, title, summary, targetWords, estimatedPages FROM chapter_outlines WHERE novelId=? ORDER BY chapterNumber`).all(novelId) as any[];
  const chapters = db.prepare(`SELECT id, chapterNumber, title, status, wordCount, pageCountEst, generationSource FROM chapters WHERE novelId=? ORDER BY chapterNumber`).all(novelId) as any[];
  return computeNavigation(outlines, chapters);
}

export async function listVersions(chapterId: string) {
  const db = getDb();
  return db.prepare(`SELECT id, chapterId, versionNum, wordCount, note, createdAt FROM chapter_versions WHERE chapterId=? ORDER BY versionNum DESC`).all(chapterId) as any[];
}

/** Restores an earlier version as a new version (never destroys history). */
export async function restoreVersion(userId: string, novelId: string, chapterId: string, versionId: string) {
  const db = getDb();
  const chapter = db.prepare(
    `SELECT c.* FROM chapters c JOIN novels n ON n.id=c.novelId WHERE c.id=? AND c.novelId=? AND n.userId=?`,
  ).get(chapterId, novelId, userId) as any;
  if (!chapter) throw new HttpError(404, 'Chapter not found', 'chapter_not_found');
  if (chapter.status === 'approved') throw new HttpError(409, 'Approved chapters are read-only.', 'chapter_approved');
  const v = db.prepare(`SELECT * FROM chapter_versions WHERE id=? AND chapterId=?`).get(versionId, chapterId) as any;
  if (!v) throw new HttpError(404, 'Version not found', 'version_not_found');

  await createVersion(userId, novelId, chapterId, 'Auto-save before restore');
  const parsed = JSON.parse(v.contentJson);
  const plain = docToPlainText(parsed);
  const words = countWords(plain);
  const settings = getSettings(novelId) as any;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE chapters SET contentJson=?, plainText=?, contentHtml=?, wordCount=?, pageCountEst=?, status='edited', updatedAt=? WHERE id=? AND novelId=?`,
  ).run(v.contentJson, plain, docToHtml(parsed), words, Math.max(1, Math.round(words / (settings?.wordsPerPage || 320))), now, chapterId, novelId);
  return { restoredVersion: v.versionNum };
}

/** Used by the memory service to read a memory's vector back. */
export { deserialize };
