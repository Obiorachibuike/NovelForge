import { auth } from '@/lib/auth/config';
import { requireNovel } from '@/lib/db/ownership';
import { getDb } from '@/lib/db';
import { listGenerations } from '@/lib/jobs/generation-jobs';
import { serializeJob } from '@/lib/queue';
import ConsistencyView from '@/components/consistency/ConsistencyView';

export default async function ConsistencyPage({ params }) {
  const session = await auth();
  const novel = await requireNovel(params.id, session.user.id);
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS total FROM chapters WHERE novelId=?').get(params.id) as { total: number };
  const approved = db.prepare("SELECT COUNT(*) AS c FROM chapters WHERE novelId=? AND status='approved'").get(params.id) as { c: number };
  const issues = db.prepare('SELECT i.*,c.chapterNumber,c.title AS chapterTitle FROM consistency_issues i LEFT JOIN chapters c ON c.id=i.chapterId WHERE i.novelId=? ORDER BY i.severity DESC,i.createdAt DESC').all(params.id) as any[];
  const open = issues.filter(i => i.status === 'open').length;
  const score = Math.max(0, 100 - open * 4);
  const latest = listGenerations(session.user.id, { novelId: params.id, allTaskTypes: true, legacyOnly: true, taskType: 'consistency', limit: 1 })[0];
  return <ConsistencyView novel={novel} score={score} issues={issues} chapterCount={total.total} approvedCount={approved.c} issueCount={open} initialJob={latest ? serializeJob(latest) : null} />;
}
