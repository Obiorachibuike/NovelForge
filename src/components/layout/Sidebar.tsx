'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Home, PlusCircle, Book, BookOpen, Library, PenTool, Eye, Upload, Settings, LogOut, Sparkles, ChevronRight, User, Moon, Sun } from 'lucide-react';
import { signOut, useSession } from 'next-auth/react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils/cn';
import { useEffect, useState } from 'react';

interface NavGroup { label: string; items: { href: string; label: string; icon: any; badge?: string }[] }

const groups: NavGroup[] = [
  { label: 'Workspace', items: [
    { href:'/dashboard', label:'Overview', icon:Home },
    { href:'/novels/new', label:'New novel', icon:PlusCircle },
  ]},
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(()=>setMounted(true),[]);

  const isNovelRoute = pathname?.startsWith('/novels/') && !pathname?.endsWith('/new');
  const novelId = isNovelRoute ? pathname.split('/')[2] : null;

  return (
    <aside className="w-64 shrink-0 border-r border-border bg-[hsl(var(--surface))] flex flex-col h-screen sticky top-0">
      <Link href="/dashboard" className="flex items-center gap-3 px-4 py-5 border-b border-border">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-900/40">
          <span className="font-serif font-bold text-white">NF</span>
        </div>
        <div>
          <div className="font-serif text-base font-semibold leading-tight">NovelForge</div>
          <div className="text-[9px] font-mono tracking-[0.18em] text-muted-foreground">WRITING STUDIO</div>
        </div>
      </Link>

      <nav className="flex-1 overflow-y-auto p-3 space-y-5">
        <NavItem href="/dashboard" icon={Home} label="Dashboard" active={pathname==='/dashboard'} />

        <NavGroup label="MY NOVELS">
          <NavItem href="/novels/new" icon={PlusCircle} label="New novel" active={pathname==='/novels/new'} />
        </NavGroup>

        {novelId && (
          <div>
            <div className="label px-3 mb-2">ACTIVE PROJECT</div>
            <div className="mx-2 mb-2 p-2.5 rounded-lg bg-primary/10 border border-primary/20">
              <ActiveNovelNav novelId={novelId} pathname={pathname||''} />
            </div>
            <NavGroup label="STUDIO">
              <NavItem href={`/novels/${novelId}/cover`} icon={Sparkles} label="Cover Studio" active={pathname?.endsWith('/cover')} />
              <NavItem href={`/novels/${novelId}/prepare`} icon={Book} label="Preparation" active={pathname?.endsWith('/prepare')} />
              <NavItem href={`/novels/${novelId}/bible`} icon={Library} label="Story Bible" active={pathname?.endsWith('/bible')} />
              <NavItem href={`/novels/${novelId}/outline`} icon={BookOpen} label="Outline" active={pathname?.endsWith('/outline')} />
              <NavItem href={`/novels/${novelId}/consistency`} icon={Eye} label="Consistency" active={pathname?.endsWith('/consistency')} />
              <NavItem href={`/novels/${novelId}/export`} icon={Upload} label="Export" active={pathname?.endsWith('/export')} />
            </NavGroup>
          </div>
        )}
      </nav>

      <div className="border-t border-border p-3 space-y-2">
        <button onClick={()=>setTheme(theme==='dark'?'light':'dark')} className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-[hsl(var(--surface-secondary))] hover:text-foreground transition">
          {mounted && theme==='dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          {mounted && theme==='dark' ? 'Light mode' : 'Dark mode'}
        </button>
        <Link href="/settings" className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-[hsl(var(--surface-secondary))] hover:text-foreground transition">
          <Settings className="w-4 h-4" /> Settings
        </Link>
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-pink-400 to-indigo-400 flex items-center justify-center text-xs font-bold">
            {session?.user?.name?.[0]?.toUpperCase() || 'U'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{session?.user?.name || 'Writer'}</div>
            <div className="text-[11px] text-muted-foreground truncate">{session?.user?.email}</div>
          </div>
          <button onClick={()=>signOut({callbackUrl:'/'})} className="text-muted-foreground hover:text-destructive p-1" title="Sign out">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

function NavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label px-3 mb-1">{label}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function NavItem({ href, icon: Icon, label, active, badge }: { href:string; icon:any; label:string; active?:boolean; badge?:string }) {
  return (
    <Link href={href} className={cn(
      'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
      active ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:bg-[hsl(var(--surface-secondary))] hover:text-foreground'
    )}>
      <Icon className="w-4 h-4" />
      <span className="flex-1">{label}</span>
      {badge && <span className="chip-primary text-[9px]">{badge}</span>}
    </Link>
  );
}

function ActiveNovelNav({ novelId, pathname }:{novelId:string; pathname:string}) {
  // We don't fetch title here — callers pass it. Use a neutral label for simplicity.
  const isWrite = pathname.includes('/write/');
  return (
    <Link href={`/novels/${novelId}`} className="block">
      <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground tracking-widest mb-1">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot" /> IN PROGRESS
      </div>
      <div className="font-serif text-sm font-semibold leading-tight mb-0.5">Open novel</div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Go to workspace</span>
        <ChevronRight className="w-3 h-3" />
      </div>
      {isWrite && <div className="mt-1 text-[10px] text-primary font-mono">/ Writing</div>}
    </Link>
  );
}
