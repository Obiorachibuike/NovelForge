import Link from 'next/link';
import { cn } from '@/lib/utils/cn';
import Image from 'next/image';
import { Clock } from 'lucide-react';
import { formatRelative } from '@/lib/utils/cn';

const stageHref: Record<string, string> = {
  create: '/novels/new',
  cover: '/cover',
  prepare: '/prepare',
  structure: '/prepare',
  outline: '/outline',
  approve: '/outline',
  writing: '/write',
  sync: '/consistency',
  consistency: '/consistency',
  export: '/export',
};

export function NovelCard({ novel }: { novel: any }) {
  const progress = Math.min(100, novel.percentComplete || 0);
  const subPath = stageHref[novel.stage] || '/prepare';
  const href = `/novels/${novel.id}${subPath === '/write' ? '/write/1' : subPath}`;
  const stageLabel: Record<string, string> = {
    create:'Draft', cover:'Cover', prepare:'Preparing', structure:'Structuring',
    outline:'Outlining', approve:'Awaiting approval', writing:'Writing',
    sync:'Syncing', consistency:'Review', export:'Ready to export',
  };
  return (
    <Link href={href} className="surface p-5 card-hover block group">
      <div className="flex gap-4 mb-4">
        <div className="w-20 h-28 shrink-0 rounded-md overflow-hidden border border-white/10 shadow-lg relative">
          {novel.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={novel.coverUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-indigo-900 to-violet-950 flex items-center justify-center text-[10px] font-mono text-indigo-200/70 tracking-widest p-2 text-center">
              {novel.title}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-serif text-lg font-semibold leading-tight truncate">{novel.title}</h3>
          </div>
          <div className="text-xs text-muted-foreground mt-1">{novel.genre} · {novel.targetWords.toLocaleString()} words</div>
          <div className="mt-2 flex items-center gap-2 text-[11px]">
            <span className={cn('chip',
              novel.status === 'completed' ? 'chip-success' :
              novel.stage === 'cover' ? 'chip-warning' : 'chip-primary'
            )}>{stageLabel[novel.stage] || novel.stage}</span>
            <span className="text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{formatRelative(novel.updatedAt)}</span>
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{novel.chaptersCompleted} / {novel.chaptersTotal || novel.targetChapters} chapters</span>
          <span className="font-mono">{progress}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all" style={{width:`${progress}%`}} />
        </div>
      </div>
    </Link>
  );
}
