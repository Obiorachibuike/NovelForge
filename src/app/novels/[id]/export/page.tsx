import { auth } from '@/lib/auth/config';
import { requireNovel } from '@/lib/db/ownership';
import { getDb } from '@/lib/db';
import ExportView from '@/components/export/ExportView';
export default async function ExportPage({params}){const session=await auth();await requireNovel(params.id,session.user.id);const db=getDb();const novel=db.prepare('SELECT * FROM novels WHERE id=?').get(params.id);const settings=db.prepare('SELECT * FROM novel_settings WHERE novelId=?').get(params.id);const exports=db.prepare('SELECT * FROM exports WHERE novelId=? ORDER BY createdAt DESC').all(params.id);return <ExportView novel={novel} settings={settings} exports={exports}/>;}
