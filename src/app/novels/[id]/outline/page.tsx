import { auth } from '@/lib/auth/config';
import { requireNovel } from '@/lib/db/ownership';
import { getDb } from '@/lib/db';
import { listGenerations } from '@/lib/jobs/generation-jobs';
import { serializeJob } from '@/lib/queue';
import OutlineEditor from '@/components/outline/OutlineEditor';
import { getNavigation } from '@/services/chapters/service';

export default async function OutlinePage({ params }) {
  const session = await auth();
  const novel = await requireNovel(params.id, session.user.id);
  const db = getDb();
  const outlines = db.prepare('SELECT * FROM chapter_outlines WHERE novelId=? ORDER BY orderIndex ASC').all(params.id);
  const acts = db.prepare('SELECT * FROM story_acts WHERE novelId=? ORDER BY orderIndex ASC').all(params.id);
  const chapters = db.prepare('SELECT id,chapterNumber,status,wordCount FROM chapters WHERE novelId=? ORDER BY chapterNumber').all(params.id);
  const navigation = await getNavigation(params.id);
  const latest = listGenerations(session.user.id, { novelId: params.id, allTaskTypes: true, legacyOnly: true, taskType: 'outline', limit: 1 })[0];
  return <OutlineEditor novel={novel} outlines={outlines} acts={acts} chapters={chapters} navigation={navigation} initialJob={latest ? serializeJob(latest) : null} />;
}
