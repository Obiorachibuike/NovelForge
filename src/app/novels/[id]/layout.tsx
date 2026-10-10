import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth/config';
import { getNovel } from '@/services/novels/service';
import { NovelHeader } from '@/components/novel/NovelHeader';
export default async function NovelLayout({children,params}){
  const session=await auth();
  if(!session?.user)redirect('/login');
  const novel=await getNovel(params.id,session.user.id);
  if(!novel)notFound();
  return <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
    <NovelHeader novel={novel}/>
    <div className="flex-1 overflow-y-auto">{children}</div>
  </div>;
}
