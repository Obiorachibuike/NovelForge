import { getDb } from '@/lib/db';
import { embed, deserialize, cosineSimilarity } from '@/lib/ai/embeddings';
import 'server-only';

/** Retrieve relevant memories for a given chapter using hybrid keyword + embedding search. */
export async function retrieveMemories(novelId: string, queryText: string, userId: string, limit = 8) {
  const db = getDb();
  // Keyword match first — cheap and reliable.
  const keywords = queryText.toLowerCase().split(/\W+/).filter(w => w.length > 4).slice(0,8);
  const likeClauses = keywords.map(() => `LOWER(content) LIKE ?`).join(' OR ');
  const likeParams = keywords.map(k => `%${k}%`);
  const keywordRows = likeClauses ? db.prepare(
    `SELECT id,kind,content,importance,embedding FROM chapter_memories WHERE novelId=? AND (${likeClauses}) ORDER BY importance DESC LIMIT 20`
  ).all(novelId, ...likeParams) as any[] : [];

  let scored = keywordRows.map(r => ({ ...r, score: 0.7 + (r.importance*0.05) }));

  // Vector similarity when embeddings available
  try {
    const qv = await embed(queryText.slice(0,1000), userId, novelId);
    const all = db.prepare(`SELECT id,kind,content,importance,embedding FROM chapter_memories WHERE novelId=?`).all(novelId) as any[];
    const withSim = all.map(r => {
      const v = deserialize(r.embedding);
      return { ...r, score: v.length ? cosineSimilarity(qv, v) + (r.importance * 0.05) : (r.importance*0.05) };
    });
    // Merge with keyword
    const byId = new Map<string, any>();
    for (const r of [...scored, ...withSim]) byId.set(r.id, !byId.has(r.id) ? r : { ...r, score: Math.max(byId.get(r.id).score, r.score) });
    scored = Array.from(byId.values());
  } catch (e) {
    // embeddings best effort
  }
  scored.sort((a,b)=>b.score-a.score);
  return scored.slice(0, limit).map(r => ({ kind: r.kind, content: r.content, score: r.score }));
}

export async function listRecentMemories(novelId: string, limit = 30) {
  const db = getDb();
  return db.prepare(`SELECT * FROM chapter_memories WHERE novelId=? ORDER BY createdAt DESC LIMIT ?`).all(novelId, limit) as any[];
}
