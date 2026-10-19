import { auth } from '@/lib/auth/config';
import { requireNovel } from '@/lib/db/ownership';
import { getDb } from '@/lib/db';
import WritingWorkspace from '@/components/editor/WritingWorkspace';
import { getNavigation, listVersions } from '@/services/chapters/service';
import { notFound } from 'next/navigation';

export default async function WritePage({ params }: any) {
  const session = (await auth()) as any;
  await requireNovel(params.id, session.user.id);
  const db = getDb();
  const nav = await getNavigation(params.id);
  const novel = db.prepare('SELECT * FROM novels WHERE id=?').get(params.id);
  let chapter: any;
  if (/^\d+$/.test(params.chapterId)) {
    const n = parseInt(params.chapterId, 10);
    chapter = db.prepare('SELECT * FROM chapters WHERE novelId=? AND chapterNumber=?').get(params.id, n);
  } else {
    chapter = db.prepare('SELECT * FROM chapters WHERE id=? AND novelId=?').get(params.chapterId, params.id);
  }
  const outline = chapter?.outlineId
    ? db.prepare('SELECT * FROM chapter_outlines WHERE id=?').get(chapter.outlineId)
    : db.prepare('SELECT * FROM chapter_outlines WHERE novelId=? AND chapterNumber=?').get(params.id, parseInt(params.chapterId, 10));
  if (!outline && !chapter) notFound();
  const prev = chapter
    ? (db.prepare("SELECT chapterNumber,summary,title FROM chapters WHERE novelId=? AND chapterNumber < ? AND status='approved' ORDER BY chapterNumber DESC LIMIT 1").get(params.id, chapter.chapterNumber) as { summary: string | null; title: string } | undefined)
    : undefined;
  const memories = db.prepare('SELECT kind,content FROM chapter_memories WHERE novelId=? ORDER BY importance DESC, createdAt DESC LIMIT 8').all(params.id) as { kind: string; content: string }[];
  const versions = chapter?.id ? await listVersions(chapter.id) : [];

  return (
    <WritingWorkspace
      key={chapter?.id || `chapter-${params.chapterId}`}
      novel={novel}
      chapter={chapter}
      outline={outline}
      navigation={nav}
      previousSummary={prev?.summary}
      memories={memories}
      initialVersions={versions}
    />
  );
}
