import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import { generateStructured } from '@/lib/ai/text-generation';
import { outlinePrompt } from '@/lib/ai/prompts';
import { registerHandler } from '@/lib/queue';
import { z } from 'zod';
import 'server-only';

const outlineShape = z.object({
  acts: z.array(z.object({
    actNumber: z.number(),
    name: z.string(),
    description: z.string().optional(),
    purpose: z.string().optional(),
    turningPoint: z.string().optional(),
    orderIndex: z.number().optional(),
  })).default([]),
  chapters: z.array(z.object({
    chapterNumber: z.number(),
    title: z.string(),
    summary: z.string().optional(),
    narrativePurpose: z.string().optional(),
    majorEvents: z.array(z.string()).default([]),
    charactersInvolved: z.array(z.string()).default([]),
    location: z.string().optional(),
    conflict: z.string().optional(),
    emotionalObjective: z.string().optional(),
    plotAdvancement: z.string().optional(),
    foreshadowing: z.string().optional(),
    targetWords: z.number().int(),
    estimatedPages: z.number().int().optional(),
  })).min(1),
});

export async function enqueueOutline(userId: string, novelId: string, structureType = 'three-act') {
  const { enqueue } = await import('@/lib/queue');
  return enqueue({ type: 'outline', userId, novelId, payload: { structureType }, idempotencyKey: `outline:${novelId}:${structureType}` });
}

export async function getNovelContext(novelId: string) {
  const db = getDb();
  const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as any;
  const premise = db.prepare('SELECT * FROM premises WHERE novelId = ?').get(novelId) as any;
  const characters = db.prepare('SELECT name,role,arc,personality FROM characters WHERE novelId = ? LIMIT 12').all(novelId) as any[];
  return { novel, premise, characters };
}

async function runOutline({ novelId, userId, payload }: any) {
  const db = getDb();
  const ctx = await getNovelContext(novelId);
  if (!ctx.novel) throw new Error('Novel not found');
  const structureType = payload?.structureType || 'three-act';

  const fallback = buildDemoOutline(ctx.novel);
  const prompt = outlinePrompt(ctx as any, structureType);
  const result = await generateStructured(outlineShape, {
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0.6, userId, novelId, taskType: 'outline', fallback,
  });

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    // Clear existing outline to be replaced (service preserves chapters if approved).
    const approvedChapters = db.prepare(`SELECT outlineId FROM chapters WHERE novelId = ? AND status = 'approved'`).all(novelId) as any[];
    const keepIds = new Set(approvedChapters.map(c => c.outlineId).filter(Boolean));
    db.prepare(`DELETE FROM chapter_outlines WHERE novelId = ? ${keepIds.size ? `AND id NOT IN (${Array.from(keepIds).map(()=>'?').join(',')})` : ''}`)
      .run(novelId, ...Array.from(keepIds));
    db.prepare(`DELETE FROM story_acts WHERE novelId = ?`).run(novelId);

    const insAct = db.prepare(`INSERT INTO story_acts (id,novelId,actNumber,name,description,purpose,turningPoint,orderIndex) VALUES (?,?,?,?,?,?,?,?)`);
    for (const a of result.acts) {
      insAct.run(nanoid(), novelId, a.actNumber, a.name, a.description || null, a.purpose || null, a.turningPoint || null, a.orderIndex ?? a.actNumber);
    }

    const ins = db.prepare(`INSERT INTO chapter_outlines (id,novelId,actId,chapterNumber,title,summary,narrativePurpose,majorEvents,charactersInvolved,location,conflict,emotionalObjective,plotAdvancement,foreshadowing,targetWords,estimatedPages,status,orderIndex) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const totalTarget = result.chapters.reduce((s,c)=>s+c.targetWords, 0);
    const scale = totalTarget > 0 ? ctx.novel.targetWords / totalTarget : 1;
    for (let i=0; i<result.chapters.length; i++) {
      const c = result.chapters[i];
      const targetWords = Math.max(500, Math.round(c.targetWords * scale));
      const estPages = c.estimatedPages || Math.max(1, Math.round(targetWords / 320));
      const num = c.chapterNumber || (i+1);
      ins.run(nanoid(), novelId, null, num, c.title, c.summary || null, c.narrativePurpose || null,
        JSON.stringify(c.majorEvents || []),
        JSON.stringify(c.charactersInvolved || []),
        c.location || null, c.conflict || null, c.emotionalObjective || null,
        c.plotAdvancement || null, c.foreshadowing || null,
        targetWords, estPages, 'planned', i);
    }

    db.prepare(`UPDATE novels SET stage='approve', updatedAt=? WHERE id=?`).run(now, novelId);
  });
  tx();
}

registerHandler('outline', runOutline);

export function listOutlines(novelId: string) {
  const db = getDb();
  return db.prepare('SELECT * FROM chapter_outlines WHERE novelId = ? ORDER BY orderIndex ASC').all(novelId) as any[];
}

export function listActs(novelId: string) {
  const db = getDb();
  return db.prepare('SELECT * FROM story_acts WHERE novelId = ? ORDER BY orderIndex ASC').all(novelId) as any[];
}

export async function approveOutline(userId: string, novelId: string) {
  const db = getDb();
  const novel = db.prepare('SELECT * FROM novels WHERE id = ? AND userId = ?').get(novelId, userId) as any;
  if (!novel) throw new Error('Novel not found');
  const outlines = listOutlines(novelId);
  if (!outlines.length) throw new Error('No outline to approve');
  const now = new Date().toISOString();
  db.prepare(`UPDATE novels SET stage='writing', approvedAt=?, status='writing', updatedAt=? WHERE id=?`).run(now, now, novelId);
}

export async function updateOutline(outlineId: string, novelId: string, userId: string, patch: Partial<{title:string; summary:string; targetWords:number; estimatedPages:number; orderIndex:number}>){
  const db = getDb();
  const sets: string[] = []; const vals: any[] = [];
  for (const [k,v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    sets.push(`${k}=?`); vals.push(v);
  }
  if (!sets.length) return;
  vals.push(outlineId, novelId, userId);
  db.prepare(`UPDATE chapter_outlines SET ${sets.join(',')} WHERE id=? AND novelId=? AND EXISTS(SELECT 1 FROM novels WHERE id=? AND userId=?)`).run(...vals, outlineId, novelId);
}

function buildDemoOutline(novel: any) {
  const total = novel.targetChapters || 12;
  const avg = Math.round((novel.targetWords||80000)/total);
  const titles = [
    'The Return','A City of Glass','The Archivist\'s Door','The Hollow Crown','Ash at the Window',
    'The Pact Remembered','Wolves of the Inner Court','The Queen\'s Messenger','Beneath the Cathedral',
    'The Usurper\'s Truth','What the River Remembers','The Last Oath','Brothers of Smoke','The Glass Crown',
    'A Vote of Ashes','The Hollow Road','Names of the Dead','The Quiet Coup','Widow of the Crossroads',
    'A Throne of Salt','The Serpent\'s Bargain','Siege of the Sixth Gate','The Child in the Archive',
    'Blood on the Pact','The First King\'s Shadow','What We Owe the Dead','Dawn at the Bridge',
    'A Choice of Kings','The Last Kingdom','Begin Again'
  ];
  const acts = [
    { actNumber:1, name:'Act I: The Return', description:'The heir crosses the border and discovers the kingdom has erased him.', purpose:'Establish world, stakes, and the central mystery.', turningPoint:'The first crack in the Ashen Pact.', orderIndex:1 },
    { actNumber:2, name:'Act II: The Unraveling', description:'Allies and enemies reveal their true shapes; the pact breaks further.', purpose:'Raise stakes and escalate conflicts.', turningPoint:'The archivist\'s secret is exposed.', orderIndex:2 },
    { actNumber:3, name:'Act III: The Choice', description:'The heir must choose between the throne and the kingdom.', purpose:'Climax and resolution.', turningPoint:'The heir refuses the crown.', orderIndex:3 },
  ];
  const chapters = Array.from({length:total}, (_,i)=>{
    const variance = 0.75 + Math.random()*0.6;
    const target = Math.round(avg*variance/100)*100;
    return {
      chapterNumber: i+1, title: titles[i % titles.length] + (i>=titles.length?` ${Math.floor(i/titles.length)+1}`:''),
      summary: `${['Kael returns','Seren discovers','The court tightens','A pact stirs','Allies gather','The truth surfaces','Blood is spilled','A choice is made'][i%8]} in this chapter.`,
      narrativePurpose: i===0 ? 'Open the novel and establish voice' : i===total-1 ? 'Climax and emotional resolution' : 'Advance plot and reveal character',
      majorEvents: [`Event ${i+1}A`, `Event ${i+1}B`],
      charactersInvolved: ['Kael','Seren'],
      location: ['Border','Glass City','The Archive','The Hollow Road','The Cathedral','The Palace'][i%6],
      conflict: 'Loyalty vs. truth',
      emotionalObjective: ['wariness','hope','betrayal','resolve','grief','resolve'][i%6],
      plotAdvancement: 'Central mystery deepens',
      foreshadowing: i<total-1 ? 'A hint of what comes next.' : undefined,
      targetWords: target,
      estimatedPages: Math.max(1, Math.round(target/320)),
    };
  });
  return { acts, chapters };
}
