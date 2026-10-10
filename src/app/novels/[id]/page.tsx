import { auth } from '@/lib/auth/config';
import { requireNovel } from '@/lib/db/ownership';
import { redirect } from 'next/navigation';
const stageRoute={create:'cover',cover:'cover',prepare:'prepare',structure:'prepare',outline:'outline',approve:'outline',writing:'write/1',sync:'write/1',consistency:'consistency',export:'export'};
export default async function NovelRoot({params}){const session=await auth();const novel=await requireNovel(params.id,session.user.id);redirect(`/novels/${params.id}/${stageRoute[novel.stage]||'cover'}`);}
