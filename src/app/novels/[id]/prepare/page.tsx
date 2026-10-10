import PreparationWorkspace from '@/components/story-bible/PreparationWorkspace';
import { auth } from '@/lib/auth/config';
import { requireNovel } from '@/lib/db/ownership';
import { getDb } from '@/lib/db';
import { updateNovelStage } from '@/services/novels/service';
export default async function PreparePage({params}){const session=await auth();const novel=await requireNovel(params.id,session.user.id);const db=getDb();const premise=db.prepare('SELECT * FROM premises WHERE novelId=?').get(params.id);const characters=db.prepare('SELECT * FROM characters WHERE novelId=? ORDER BY createdAt LIMIT 12').all(params.id);const worldRules=db.prepare('SELECT * FROM world_rules WHERE novelId=? LIMIT 12').all(params.id);if(['cover','create'].includes(novel.stage))await updateNovelStage(params.id,session.user.id,'prepare');return <PreparationWorkspace novel={novel} premise={premise} characters={characters} worldRules={worldRules}/>;}
