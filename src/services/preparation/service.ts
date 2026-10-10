import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import { generateStructured } from '@/lib/ai/text-generation';
import { premisePrompt } from '@/lib/ai/prompts';
import { embed } from '@/lib/ai/embeddings';
import { serialize } from '@/lib/ai/embeddings';
import { registerHandler } from '@/lib/queue';
import { z } from 'zod';
import 'server-only';

const premiseShape = z.object({
  logline: z.string(),
  shortSynopsis: z.string(),
  fullSynopsis: z.string(),
  themes: z.array(z.string()).default([]),
  setting: z.string(),
  majorConflicts: z.array(z.string()).default([]),
  mainCharacters: z.array(z.object({
    name: z.string(), role: z.string().default('supporting'), age: z.string().optional(),
    personality: z.string().optional(), motivation: z.string().optional(),
    goal: z.string().optional(), fear: z.string().optional(), arc: z.string().optional(),
  })).default([]),
  supportingCharacters: z.array(z.object({
    name: z.string(), role: z.string().default('supporting'), age: z.string().optional(),
    personality: z.string().optional(), motivation: z.string().optional(),
    goal: z.string().optional(), fear: z.string().optional(), arc: z.string().optional(),
  })).default([]),
  worldRules: z.array(z.object({
    name: z.string(), description: z.string(), category: z.string().optional(),
  })).default([]),
  timelineFoundation: z.array(z.object({
    label: z.string(), description: z.string(), when: z.string().optional(), orderIndex: z.number().optional(),
  })).default([]),
});

export async function enqueuePrepareNovel(userId: string, novelId: string) {
  const { enqueue } = await import('@/lib/queue');
  return enqueue({ type: 'premise', userId, novelId, payload: {} });
}

export async function getPremise(novelId: string) {
  const db = getDb();
  return db.prepare('SELECT * FROM premises WHERE novelId = ?').get(novelId) as any;
}

async function runPremise({ novelId, userId }: { novelId:string; userId:string }) {
  const db = getDb();
  const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as any;
  if (!novel) throw new Error('Novel not found');

  const prompt = premisePrompt(novel);
  const fallback = makeDemoPremise(novel);
  const p = await generateStructured(premiseShape, {
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0.7,
    userId, novelId, taskType: 'premise',
    fallback,
  });

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    // Premise row
    const existing = db.prepare('SELECT id FROM premises WHERE novelId = ?').get(novelId) as any;
    if (existing) {
      db.prepare(`UPDATE premises SET logline=?, shortSynopsis=?, fullSynopsis=?, themes=?, setting=?, majorConflicts=?, updatedAt=? WHERE novelId=?`)
        .run(p.logline, p.shortSynopsis, p.fullSynopsis, JSON.stringify(p.themes), p.setting, JSON.stringify(p.majorConflicts), now, novelId);
    } else {
      db.prepare(`INSERT INTO premises (id,novelId,logline,shortSynopsis,fullSynopsis,themes,setting,majorConflicts,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(nanoid(), novelId, p.logline, p.shortSynopsis, p.fullSynopsis,
          JSON.stringify(p.themes), p.setting, JSON.stringify(p.majorConflicts), now, now);
    }

    // Story bible
    const bible = db.prepare('SELECT id FROM story_bibles WHERE novelId = ?').get(novelId) as any;
    const overview = `${p.shortSynopsis}\n\n${p.fullSynopsis}`;
    if (bible) {
      db.prepare(`UPDATE story_bibles SET overview=?, toneNotes=?, styleGuide=?, updatedAt=? WHERE novelId=?`)
        .run(overview, novel.tone || '', novel.style || '', now, novelId);
    } else {
      db.prepare(`INSERT INTO story_bibles (id,novelId,overview,toneNotes,styleGuide,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`)
        .run(nanoid(), novelId, overview, novel.tone || '', novel.style || '', now, now);
    }

    // Characters (don't overwrite if any already exist)
    const charCount = db.prepare('SELECT COUNT(*) AS c FROM characters WHERE novelId = ?').get(novelId) as any;
    if (charCount.c === 0) {
      const insertChar = db.prepare(`INSERT INTO characters (id,novelId,name,role,age,personality,motivation,goals,fears,arc,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insertLoc = db.prepare(`INSERT INTO locations (id,novelId,name,description,kind,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`);
      const insertRule = db.prepare(`INSERT INTO world_rules (id,novelId,name,description,category,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`);
      const insertEvent = db.prepare(`INSERT INTO timeline_events (id,novelId,label,description,"when",orderIndex,createdAt) VALUES (?,?,?,?,?,?,?)`);
      const insertMemory = db.prepare(`INSERT INTO chapter_memories (id,novelId,kind,content,importance,embedding,createdAt) VALUES (?,?,?,?,?,?,?)`);

      for (const c of [...p.mainCharacters, ...p.supportingCharacters]) {
        insertChar.run(nanoid(), novelId, c.name, c.role || 'supporting', c.age || null, c.personality || null,
          c.motivation || null, c.goal || null, c.fear || null, c.arc || null, now, now);
      }
      // Extract a simple location from setting (first sentence as name)
      const locName = (p.setting || 'Unknown land').split(/[.,]| - /)[0].trim();
      insertLoc.run(nanoid(), novelId, locName, p.setting, 'setting', now, now);
      for (const r of p.worldRules) {
        insertRule.run(nanoid(), novelId, r.name, r.description, r.category || 'world', now, now);
      }
      for (const [i,e] of p.timelineFoundation.entries()) {
        insertEvent.run(nanoid(), novelId, e.label, e.description, e.when || null, e.orderIndex ?? i, now);
      }
      // Seed memory with premise
      insertMemory.run(nanoid(), novelId, 'summary', overview, 5, null, now);
    }

    // Advance stage to structure if currently at prepare
    db.prepare(`UPDATE novels SET stage = CASE WHEN stage='prepare' THEN 'structure' ELSE stage END, updatedAt=? WHERE id=?`)
      .run(now, novelId);
  });
  tx();

  // Kick embeddings async (fire and forget, failure ok)
  Promise.all([embed(p.logline, userId, novelId), embed(p.shortSynopsis, userId, novelId)])
    .catch(err => console.warn('embed failed', err));
}

registerHandler('premise', runPremise);

function makeDemoPremise(novel: any) {
  const title = novel.title || 'The Last Kingdom';
  return {
    logline: `An exiled heir returns to a kingdom that has forgotten him — and must choose between the throne and the people who betrayed it.`,
    shortSynopsis: `After twelve years in exile, ${protagonistName(title)} crosses back into a kingdom that has erased the royal line. Aided by an archivist with secrets of her own, they must piece together an ancient pact before a long-forgotten enemy breaks through the world's foundations.`,
    fullSynopsis: `Twelve years after the royal family was overthrown in a single bloody night, a quiet wanderer returns to the capital under a borrowed name. The city is brighter now — glass towers, cheerful markets, a new king on the throne — but beneath the lights, the old magic is fraying.\n\nAided by a sharp-tongued archivist who knew the royal children as a girl, the wanderer must gather the fragments of a covenant sworn by forgotten kings. But as they close on the truth, they begin to suspect that the coup they've spent a decade hating may have been the only thing keeping an older, crueler power in check.\n\nIn the end the heir must choose: reclaim the crown and restart an ancient cycle, or let the kingdom forget its kings forever — and pay the price.`,
    themes: ['Memory and identity','The weight of legacy','What loyalty requires','Power and its quiet cost'],
    setting: `A late-medieval/renaissance kingdom of pale stone and smoked glass, ringed by older forest where magic still remembers the blood of the old kings. The weather is turning cold.`,
    majorConflicts: ['The heir vs. the usurper king','The heir vs. his own father\'s legacy','The kingdom vs. the awakening pact','The archivist\'s secret loyalty','Fear of magic vs. fear of its absence'],
    mainCharacters: [
      { name: protagonistName(title), role: 'protagonist', age: '29', personality: 'Wary, dry, observant; slow to trust but fierce with those he loves.', motivation: 'Reclaim his name without becoming his father.', goal: 'Restore the Ashen Pact.', fear: 'Becoming the kind of king who would sacrifice a city to save the crown.', arc: 'From revenge to responsibility.' },
      { name: 'Seren Vale', role: 'ally', age: '28', personality: 'Sharp, ironic, fiercely intelligent. Hides a romantic heart behind precision.', motivation: 'Preserve the truth even when the kingdom wants to forget it.', goal: 'Redeem the archive\'s silence.', fear: 'That she helped the coup by saying nothing.', arc: 'From archivist to actor.' },
      { name: 'King Theron', role: 'antagonist', age: '48', personality: 'Charming, tired, ruthless; he believes he is the hero of the story.', motivation: 'Protect the kingdom from the pact.', goal: 'Destroy the old magic entirely.', fear: 'That his reign was built on a lie.', arc: 'From usurper to tragic reflection.' },
    ],
    supportingCharacters: [
      { name: 'Captain Ido', role: 'supporting', age: '41', personality: 'Loyal, tired, dryly humorous.', motivation: 'Protect the city regardless of who sits on the throne.', goal: 'Keep the peace.', fear: 'Choosing the wrong side again.', arc: 'From king\'s guard to moral conscience.' },
      { name: 'The Widow of the Hollow Road', role: 'supporting', age: 'Unknown', personality: 'Cryptic but kind.', motivation: 'Keep the pact\'s terms.', goal: 'Find an heir who will listen.', fear: 'The pact breaking.', arc: 'From oracle to ally.' },
    ],
    worldRules: [
      { name: 'The Ashen Pact', description: 'The crown is bound to the land; kings are nourished by it and die feeding it in turn.', category: 'magic' },
      { name: 'Names of the Old Kings', description: 'Speaking a dead king\'s true name in the Hollow Road calls his oath.', category: 'magic' },
      { name: 'Glass-Touched', description: 'Citizens who survive long exposure to the Glass City gradually lose their memories of the previous rulers.', category: 'society' },
    ],
    timelineFoundation: [
      { label: 'The Night of Smoke', description: 'The royal family is killed in a coup; the heir is smuggled out at age 17.', when: '12 years prior', orderIndex: 0 },
      { label: 'The Wanderer Returns', description: 'The heir crosses the border under a false name.', when: 'present', orderIndex: 1 },
      { label: 'The Archivist\'s Door', description: 'Seren reveals the royal records survived.', when: 'present, day 3', orderIndex: 2 },
      { label: 'The First Crack', description: 'The pact shows the first sign of failing.', when: 'present, week 2', orderIndex: 3 },
      { label: 'The Choice', description: 'The heir must choose between crown and kingdom.', when: 'climax', orderIndex: 4 },
    ],
  };
}

function protagonistName(title: string) {
  const lower = title.toLowerCase();
  if (lower.includes('kingdom')) return 'Kael';
  if (lower.includes('empire')) return 'Marcus';
  if (lower.includes('garden')) return 'Iris';
  return 'Alex';
}

export async function updatePremiseField(novelId: string, userId: string, patch: Record<string,unknown>) {
  const db = getDb();
  const novel = db.prepare('SELECT * FROM novels WHERE id=? AND userId=?').get(novelId, userId);
  if (!novel) throw new Error('Novel not found');
  const existing = await getPremise(novelId);
  const sets: string[] = []; const vals: any[] = [];
  for (const [k,v] of Object.entries(patch)) {
    sets.push(`${k} = ?`); vals.push(typeof v === 'object' ? JSON.stringify(v) : v);
  }
  vals.push(new Date().toISOString(), novelId);
  db.prepare(`UPDATE premises SET ${sets.join(', ')}, updatedAt=? WHERE novelId=?`).run(...vals);
  return getPremise(novelId);
}
