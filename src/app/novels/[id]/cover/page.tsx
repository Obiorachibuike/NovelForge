import CoverStudio from '@/components/visuals/CoverStudio';
import { auth } from '@/lib/auth/config';
import { requireNovel } from '@/lib/db/ownership';
import { getDb } from '@/lib/db';
import { updateNovelStage } from '@/services/novels/service';
export default async function CoverPage({params}){const session=await auth();const novel=await requireNovel(params.id,session.user.id);const db=getDb();const covers=db.prepare('SELECT * FROM image_assets WHERE novelId=? AND kind=? ORDER BY isPrimary DESC, createdAt DESC').all(params.id,'cover');if(['cover','create'].includes(novel.stage))await updateNovelStage(params.id,session.user.id,'cover');return <CoverStudio novel={novel} initialCovers={covers}/>;}
