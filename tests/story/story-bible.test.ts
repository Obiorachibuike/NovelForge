import { describe, expect, it, beforeEach, vi } from 'vitest';
import { freshDatabase, seedUser, seedNovel, seedOutline, seedChapter, db, jsonRequest, readJson } from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import { GET as getConsistency, POST as runConsistency, PATCH as resolveIssue } from '@/app/api/novels/[id]/consistency/route';
import { retrieveMemories, listRecentMemories } from '@/services/memory/service';
import { enqueueConsistencyCheck } from '@/services/consistency/service';
import { enqueueMemoryExtraction, approveChapter } from '@/services/chapters/service';
import { drainQueue, getJob } from '@/lib/queue';

let user: { id: string; email: string; name: string };
let novel: { id: string; userId: string };

const CHAPTER_ONE = [
  'Mira Vale counted the bells again. The harbour was empty, and the tide had gone out further than it should have.',
  '',
  'She had promised herself she would not go back to the lighthouse. Promises, she was learning, were a kind of weather.',
].join('\n');

beforeEach(() => {
  freshDatabase();
  user = seedUser({ name: 'Author' });
  novel = seedNovel(user.id, { title: 'The Salt Bell' });
  seedOutline(novel.id, 3);
  seedChapter(novel.id, { chapterNumber: 1, status: 'generated', plainText: CHAPTER_ONE, wordCount: 44 });
  session.userId = user.id;
});

async function drain() {
  for (let i = 0; i < 10; i++) {
    const pending = db().prepare(`SELECT COUNT(*) AS c FROM generation_jobs WHERE status='queued'`).get() as any;
    if (!pending.c) break;
    if (!(await drainQueue({ limit: 5, workerId: 'story-worker' })).length) break;
  }
}

describe('story memory', () => {
  it('approved chapters are summarised into durable memory rows', async () => {
    const chapter = db().prepare('SELECT id FROM chapters WHERE novelId=?').get(novel.id) as any;
    await approveChapter(user.id, novel.id, chapter.id);
    await drain();

    const memories = await listRecentMemories(novel.id);
    expect(memories.length).toBeGreaterThan(0);
    expect(memories.some((m: any) => m.kind === 'summary')).toBe(true);

    const updated = db().prepare('SELECT summary, status FROM chapters WHERE id=?').get(chapter.id) as any;
    expect(updated.status).toBe('approved');
    expect(updated.summary).toBeTruthy();
  });

  it('retrieval is scoped to the novel and surfaces related memories', async () => {
    const chapter = db().prepare('SELECT id FROM chapters WHERE novelId=?').get(novel.id) as any;
    await approveChapter(user.id, novel.id, chapter.id);
    await drain();

    const related = await retrieveMemories(novel.id, 'the lighthouse and the harbour bells', user.id);
    expect(related.length).toBeGreaterThan(0);
    expect(JSON.stringify(related)).toMatch(/lighthouse|bells|harbour/i);

    // Memories from a different novel (and therefore a different author's
    // world) must never appear in the results.
    const other = seedNovel(seedUser({ name: 'Other' }).id, { title: 'Other Book' });
    db().prepare(`INSERT INTO chapter_memories (id,novelId,chapterId,kind,content,importance,createdAt) VALUES (?,?,?,?,?,?,?)`)
      .run('m_other', other.id, null, 'summary', 'A secret that belongs to another novel.', 10, new Date().toISOString());
    const scoped = await retrieveMemories(novel.id, 'another novel secret', user.id);
    expect(JSON.stringify(scoped)).not.toContain('belongs to another novel');
  });

  it('memory extraction is idempotent per chapter', async () => {
    const chapter = db().prepare('SELECT id FROM chapters WHERE novelId=?').get(novel.id) as any;
    db().prepare(`UPDATE chapters SET status='approved' WHERE id=?`).run(chapter.id);
    const first = await enqueueMemoryExtraction(user.id, novel.id, chapter.id);
    const duplicate = await enqueueMemoryExtraction(user.id, novel.id, chapter.id);
    expect(duplicate).toBe(first);
    await drain();
    // Re-running after the job finished is allowed, but must not duplicate rows.
    await enqueueMemoryExtraction(user.id, novel.id, chapter.id);
    await drain();
    const count = db().prepare(`SELECT COUNT(*) AS c FROM chapter_memories WHERE chapterId=? AND kind='summary'`).get(chapter.id) as any;
    expect(count.c).toBe(1);
  });
});

describe('consistency engine', () => {
  it('catches a deliberately introduced contradiction', async () => {
    // Story Bible: Mira dies later in the book.
    db().prepare(`INSERT INTO characters (id,novelId,name,role,age,personality,arc,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('char_mira', novel.id, 'Mira Vale', 'protagonist', 29, 'stubborn, careful', 'Dies protecting the bell tower.', new Date().toISOString(), new Date().toISOString());
    // Chapter text has her alive and active.
    db().prepare(`UPDATE chapters SET plainText=? WHERE novelId=? AND chapterNumber=1`)
      .run('Mira smiled and said nothing at all. She walked to the window and laughed at the gulls.', novel.id);

    const jobId = await enqueueConsistencyCheck(user.id, novel.id);
    await drain();
    expect((await getJob(jobId))?.status).toBe('completed');

    const issues = db().prepare(`SELECT * FROM consistency_issues WHERE novelId=?`).all(novel.id) as any[];
    expect(issues.some(i => /dead character/i.test(i.title))).toBe(true);
  });

  it('flags a chapter that drifts away from every tracked character', async () => {
    db().prepare(`INSERT INTO characters (id,novelId,name,role,age,personality,arc,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('c1', novel.id, 'Mira Vale', 'protagonist', 29, '', 'Grows up.', new Date().toISOString(), new Date().toISOString());
    db().prepare(`INSERT INTO characters (id,novelId,name,role,age,personality,arc,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('c2', novel.id, 'Tobias Renn', 'antagonist', 40, '', 'Falls.', new Date().toISOString(), new Date().toISOString());
    db().prepare(`UPDATE chapters SET plainText=? WHERE novelId=? AND chapterNumber=1`)
      .run('The unnamed stranger rowed for three days. ' + 'Nothing here mentions a soul from the outline. '.repeat(12), novel.id);

    await enqueueConsistencyCheck(user.id, novel.id);
    await drain();

    const issues = db().prepare(`SELECT * FROM consistency_issues WHERE novelId=?`).all(novel.id) as any[];
    expect(issues.some(i => /no story bible characters appear/i.test(i.title))).toBe(true);
  });

  it('never rewrites the manuscript it is analysing', async () => {
    const before = db().prepare('SELECT plainText, wordCount FROM chapters WHERE novelId=? AND chapterNumber=1').get(novel.id) as any;
    db().prepare(`INSERT INTO characters (id,novelId,name,role,age,personality,arc,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('char_x', novel.id, 'Mira Vale', 'protagonist', 29, '', 'Dies in chapter nine.', new Date().toISOString(), new Date().toISOString());

    await enqueueConsistencyCheck(user.id, novel.id);
    await drain();

    const after = db().prepare('SELECT plainText, wordCount FROM chapters WHERE novelId=? AND chapterNumber=1').get(novel.id) as any;
    expect(after.plainText).toBe(before.plainText);
    expect(after.wordCount).toBe(before.wordCount);
  });

  it('reports advisory results and degrades honestly when AI is unavailable', async () => {
    const res = await runConsistency(jsonRequest(`/api/novels/${novel.id}/consistency`, {}, { method: 'POST' }), { params: { id: novel.id } });
    const body = await readJson(res);
    const jobId = body.jobId;
    await drain();
    const job = await getJob(jobId);
    expect(job?.status).toBe('completed');
    const result = JSON.parse(job!.result!);
    expect(result).toHaveProperty('chaptersChecked');
    expect(result.note).toMatch(/never modified automatically/i);
    // Demo mode is not a failure, so nothing should be marked unavailable.
    expect(result.aiUnavailable).toBe(0);
  });

  it('issues are listed and can be resolved or ignored by their owner', async () => {
    db().prepare(`INSERT INTO consistency_issues (id,novelId,chapterId,kind,severity,title,description,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('issue_1', novel.id, null, 'timeline', 'warning', 'Timeline drift', 'desc', 'open', new Date().toISOString(), new Date().toISOString());

    const listed = await readJson(await getConsistency(jsonRequest(`/api/novels/${novel.id}/consistency`), { params: { id: novel.id } }));
    expect(listed.some((i: any) => i.id === 'issue_1')).toBe(true);

    const resolved = await resolveIssue(jsonRequest(`/api/novels/${novel.id}/consistency`, { issueId: 'issue_1', status: 'ignored' }, { method: 'PATCH' }), { params: { id: novel.id } });
    expect(resolved.status).toBe(200);
    expect((db().prepare('SELECT status FROM consistency_issues WHERE id=?').get('issue_1') as any).status).toBe('ignored');
  });
});
