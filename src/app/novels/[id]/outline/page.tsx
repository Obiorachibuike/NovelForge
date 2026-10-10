import { auth } from '@/lib/auth/config';
import { requireNovel } from '@/lib/db/ownership';
import { getDb } from '@/lib/db';
import OutlineEditor from '@/components/outline/OutlineEditor';
export default async function OutlinePage({params}){const session=await auth();const novel=await requireNovel(params.id,session.user.id);const db=getDb();const outlines=db.prepare('SELECT * FROM chapter_outlines WHERE novelId=? ORDER BY orderIndex ASC').all(params.id);const acts=db.prepare('SELECT * FROM story_acts WHERE novelId=? ORDER BY orderIndex ASC').all(params.id);const chapters=db.prepare('SELECT id,chapterNumber,status,wordCount FROM chapters WHERE novelId=? ORDER BY chapterNumber').all(params.id);return <OutlineEditor novel={novel} outlines={outlines} acts={acts} chapters={chapters}/>;}
