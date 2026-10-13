import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import { generateStructuredDetailed } from '@/lib/ai/text-generation';
import { HttpError } from '@/lib/api/http';
import { consistencyCheckPrompt } from '@/lib/ai/prompts';
import { registerHandler } from '@/lib/queue';
import { z } from 'zod';
import 'server-only';

/**
 * Queues a consistency check. Concurrency is deduplicated by idempotency key so
 * repeated clicks cannot spawn parallel paid analyses of the same novel.
 */
export async function enqueueConsistencyCheck(userId: string, novelId: string, chapterId?: string) {
  const db = getDb();
  const novel = db.prepare('SELECT id FROM novels WHERE id = ? AND userId = ?').get(novelId, userId);
  if (!novel) throw new HttpError(404, 'Novel not found', 'novel_not_found');
  if (chapterId) {
    const chapter = db.prepare('SELECT id FROM chapters WHERE id = ? AND novelId = ?').get(chapterId, novelId);
    if (!chapter) throw new HttpError(404, 'Chapter not found', 'chapter_not_found');
  }
  const { enqueue } = await import('@/lib/queue');
  return enqueue({
    type: 'consistency', userId, novelId,
    payload: { chapterId: chapterId || null },
    idempotencyKey: `consistency:${novelId}`,
  });
}

async function runConsistency({ novelId, userId, payload }: any) {
  const db = getDb();
  const novel = db.prepare('SELECT * FROM novels WHERE id=?').get(novelId) as any;
  if (!novel) throw new Error('Novel not found');
  const chapters = payload.chapterId
    ? [db.prepare('SELECT * FROM chapters WHERE id=?').get(payload.chapterId)]
    : db.prepare(`SELECT * FROM chapters WHERE novelId=? AND status IN ('generated','edited','approved') ORDER BY chapterNumber ASC`).all(novelId) as any[];

  const bibleText = buildBibleSnapshot(novelId);
  const issueShape = z.array(z.object({
    kind: z.enum(['timeline','character','location','world','thread','relationship']),
    severity: z.enum(['info','warning','error']),
    title: z.string(),
    description: z.string(),
    evidence: z.string().optional(),
    suggestion: z.string().optional(),
  }));

  const now = new Date().toISOString();
  let aiUnavailable = 0;
  for (const ch of chapters) {
    if (!ch?.plainText) continue;
    const prompt = consistencyCheckPrompt(novel, { number: ch.chapterNumber, title: ch.title }, ch.plainText, bibleText);
    const fallback: any[] = [];
    // Heuristic checks always run, with or without AI.
    const heuristicIssues = heuristicCheck(novelId, ch);
    let aiIssues: any[] = [];
    const { data: aiResult, meta } = await generateStructuredDetailed(issueShape, {
      messages: [{ role:'system', content: prompt.system }, { role:'user', content: prompt.user }],
      temperature: 0.1, userId, novelId, taskType: 'consistency', fallback,
    });
    if (meta.usedFallback) {
      // Report the degraded run instead of presenting an empty result as "clean".
      aiUnavailable++;
      console.warn(`[consistency] AI analysis unavailable for chapter ${ch.chapterNumber}: ${meta.fallbackReason}`);
    } else {
      aiIssues = aiResult;
    }
    const issues = [...heuristicIssues, ...aiIssues];
    // Mark previous open issues for this chapter as resolved (refresh)
    db.prepare(`DELETE FROM consistency_issues WHERE novelId=? AND chapterId=?`).run(novelId, ch.id);
    const ins = db.prepare(`INSERT INTO consistency_issues (id,novelId,chapterId,kind,severity,title,description,evidence,suggestion,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const it of issues) {
      ins.run(nanoid(), novelId, ch.id, it.kind, it.severity, it.title, it.description, it.evidence || null, it.suggestion || null, 'open', now, now);
    }
  }

  return {
    chaptersChecked: chapters.length,
    aiUnavailable,
    note: 'Consistency findings are advisory. Chapter text is never modified automatically.',
  };
}

registerHandler('consistency', runConsistency);

function buildBibleSnapshot(novelId: string): string {
  const db = getDb();
  const premise = db.prepare('SELECT logline,shortSynopsis,themes,setting FROM premises WHERE novelId=?').get(novelId) as any;
  const chars = db.prepare('SELECT name,role,age,personality,arc FROM characters WHERE novelId=? LIMIT 20').all(novelId) as any[];
  const rules = db.prepare('SELECT name,description,category FROM world_rules WHERE novelId=? LIMIT 20').all(novelId) as any[];
  const threads = db.prepare('SELECT title,description,status FROM plot_threads WHERE novelId=? LIMIT 20').all(novelId) as any[];
  const timeline = db.prepare('SELECT label,description,"when" FROM timeline_events WHERE novelId=? ORDER BY orderIndex LIMIT 30').all(novelId) as any[];
  const parts: string[] = [];
  if (premise) {
    parts.push(`# Premise\nLogline: ${premise.logline||''}\nSetting: ${premise.setting||''}\nSynopsis: ${premise.shortSynopsis||''}`);
  }
  if (chars.length) parts.push(`# Characters\n` + chars.map(c=>`- ${c.name} (${c.role}, age ${c.age||'unknown'}): ${c.personality||''}. Arc: ${c.arc||''}`).join('\n'));
  if (rules.length) parts.push(`# World Rules\n` + rules.map(r=>`- [${r.category||'world'}] ${r.name}: ${r.description}`).join('\n'));
  if (threads.length) parts.push(`# Plot Threads\n` + threads.map(t=>`- [${t.status}] ${t.title}: ${t.description}`).join('\n'));
  if (timeline.length) parts.push(`# Timeline\n` + timeline.map((t,i)=>`${i+1}. ${t.when||''} — ${t.label}: ${t.description}`).join('\n'));
  return parts.join('\n\n');
}

function heuristicCheck(novelId: string, chapter: any) {
  const issues: any[] = [];
  const db = getDb();
  const text = (chapter.plainText || '').toLowerCase();
  // Dead-character check
  const deadChars = db.prepare(`SELECT name FROM characters WHERE novelId=? AND (lower(arc) LIKE '%dies%' OR lower(arc) LIKE '%killed%' OR lower(arc) LIKE '%dead%')`).all(novelId) as any[];
  for (const c of deadChars) {
    const first = (c.name.split(' ')[0] || c.name).toLowerCase();
    const aliveHints = [' smiled',' laughed',' said',' walked',' nodded',' stood'];
    if (first.length > 2 && text.includes(first)) {
      const nearby = text.split(first)[1]?.slice(0, 60) || '';
      if (aliveHints.some(h => nearby.includes(h))) {
        issues.push({
          kind: 'character', severity: 'warning',
          title: `Possibly dead character appears: ${c.name}`,
          description: `${c.name} is marked as dead in the Story Bible but appears active in this chapter.`,
          evidence: `...${first}${nearby.slice(0,40)}...`,
          suggestion: `Either update the character state or revise the scene.`,
        });
      }
    }
  }
  // Character present in the chapter text but missing from the Story Bible.
  const bibleNames = (db.prepare('SELECT name FROM characters WHERE novelId=?').all(novelId) as any[])
    .map(c => (c.name.split(' ')[0] || '').toLowerCase()).filter(n => n.length > 3);
  if (bibleNames.length) {
    const mentioned = bibleNames.filter(n => text.includes(n));
    const unmentioned = bibleNames.filter(n => !mentioned.includes(n));
    if (unmentioned.length === bibleNames.length && bibleNames.length > 1 && text.length > 400) {
      issues.push({
        kind: 'character', severity: 'info',
        title: 'No Story Bible characters appear in this chapter',
        description: `None of the ${bibleNames.length} tracked first names appear in the text. This can be intentional (a new POV), but it often means the chapter drifted from the plan.`,
        evidence: null,
        suggestion: 'Check whether this chapter is meant to focus on new or secondary characters.',
      });
    }
  }

  // Word count against target
  const outline = db.prepare('SELECT targetWords FROM chapter_outlines WHERE novelId=? AND chapterNumber=?').get(novelId, chapter.chapterNumber) as any;
  if (outline) {
    const overshoot = chapter.wordCount > outline.targetWords * 1.5;
    const undershoot = chapter.wordCount && chapter.wordCount < outline.targetWords * 0.4;
    if (overshoot) issues.push({ kind:'thread', severity:'info', title:'Chapter overshoots target', description:`This chapter is ${chapter.wordCount} words vs. ${outline.targetWords} planned.`, evidence:null, suggestion:'Consider splitting or trimming during edit.' });
    if (undershoot) issues.push({ kind:'thread', severity:'info', title:'Chapter short of target', description:`This chapter is ${chapter.wordCount} words vs. ${outline.targetWords} planned.`, evidence:null, suggestion:'You can expand using the AI editor.' });
  }
  return issues;
}

export function listIssues(novelId: string) {
  const db = getDb();
  return db.prepare(`SELECT i.*, c.chapterNumber, c.title AS chapterTitle FROM consistency_issues i LEFT JOIN chapters c ON c.id=i.chapterId WHERE i.novelId=? ORDER BY i.severity DESC, i.createdAt DESC`).all(novelId) as any[];
}

export async function resolveIssue(userId: string, novelId: string, issueId: string, status: 'resolved'|'ignored') {
  const db = getDb();
  db.prepare(`UPDATE consistency_issues SET status=?, updatedAt=? WHERE id=? AND novelId=? AND EXISTS(SELECT 1 FROM novels WHERE id=? AND userId=?)`)
    .run(status, new Date().toISOString(), issueId, novelId, novelId, userId);
}
