'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import { Sparkles, Book, Library, BookOpen, PenTool, Eye, Upload, Home, ChevronRight } from 'lucide-react';

const tabs: { key: string; label: string; href: (id: string) => string; icon: any; stages: string[] }[] = [
  { key:'cover', label:'Cover', href: id=>`/novels/${id}/cover`, icon: Sparkles, stages:['cover'] },
  { key:'prepare', label:'Prepare', href: id=>`/novels/${id}/prepare`, icon: Book, stages:['prepare','structure'] },
  { key:'bible', label:'Story Bible', href: id=>`/novels/${id}/bible`, icon: Library, stages:[] },
  { key:'outline', label:'Outline', href: id=>`/novels/${id}/outline`, icon: BookOpen, stages:['outline','approve'] },
  { key:'write', label:'Writing', href: id=>`/novels/${id}/write/1`, icon: PenTool, stages:['writing','sync'] },
  { key:'consistency', label:'Consistency', href: id=>`/novels/${id}/consistency`, icon: Eye, stages:['consistency'] },
  { key:'export', label:'Export', href: id=>`/novels/${id}/export`, icon: Upload, stages:['export'] },
];

const stageLabels: Record<string,string> = {
  create:'Creating', cover:'Cover', prepare:'Preparing', structure:'Structuring',
  outline:'Outlining', approve:'Ready to approve', writing:'Writing', sync:'Synchronizing',
  consistency:'Consistency', export:'Exporting',
};

export function NovelHeader({ novel }: { novel: any }) {
  const pathname = usePathname();
  const activeTab = tabs.find(t => pathname?.startsWith(t.href(novel.id).split('/write/')[0])) || tabs[0];
  const currentStage = stageLabels[novel.stage] || 'Writing';
  return (
    <div className="border-b border-border bg-[hsl(var(--surface))] sticky top-0 z-20">
      <div className="px-8 pt-5 pb-0 max-w-[1600px] mx-auto">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
          <Link href="/dashboard" className="hover:text-foreground"><Home className="w-3 h-3 inline" /> My novels</Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-medium">{novel.title}</span>
          <span className="ml-auto chip chip-primary">{currentStage}</span>
        </div>
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-serif text-3xl font-semibold leading-tight">{novel.title}</h1>
            <div className="text-sm text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
              <span>{novel.genre}</span>
              <span>·</span>
              <span>{(novel.wordsWritten||0).toLocaleString()} / {novel.targetWords.toLocaleString()} words</span>
              <span>·</span>
              <span>{novel.chaptersCompleted} / {novel.chaptersTotal || novel.targetChapters} chapters approved</span>
              <span>·</span>
              <span>{novel.percentComplete}% complete</span>
            </div>
          </div>
          <div className="flex items-center gap-2 pb-2">
            <div className="w-40 h-1.5 rounded-full bg-white/5 overflow-hidden">
              <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{width:`${novel.percentComplete}%`}} />
            </div>
          </div>
        </div>
        <nav className="flex gap-1 mt-4 overflow-x-auto -mb-px">
          {tabs.map(t => {
            const href = t.href(novel.id);
            const isActive = activeTab.key === t.key;
            const locked = isStageLocked(novel.stage, t.stages);
            return (
              <Link key={t.key} href={href} className={cn(
                'flex items-center gap-2 px-4 py-2.5 text-sm rounded-t-lg border-b-2 transition whitespace-nowrap',
                isActive ? 'border-primary text-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground',
                locked && !isActive && 'opacity-50 pointer-events-none'
              )}>
                <t.icon className="w-4 h-4" />
                {t.label}
                {locked && !isActive && <span className="text-[10px] chip-muted">Locked</span>}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

function isStageLocked(currentStage: string, tabStages: string[]) {
  // Always allow Bible, Consistency, Export
  if (!tabStages.length) return false;
  const order = ['create','cover','prepare','structure','outline','approve','writing','sync','consistency','export'];
  const currentIdx = order.indexOf(currentStage);
  // Locked if tab's minimum stage is later than current (but never lock bible/export/consistency)
  const tabIdx = Math.min(...tabStages.map(s => order.indexOf(s)));
  return tabIdx > currentIdx + 1 && !(currentStage === 'writing' && tabStages.includes('consistency'));
}
