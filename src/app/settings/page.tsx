import { auth } from '@/lib/auth/config';
import { LogOut } from 'lucide-react';
export default async function SettingsPage() {
  const session = await auth();
  return <div className="p-8 max-w-3xl mx-auto w-full">
    <div className="mb-8"><div className="label text-primary mb-2">SETTINGS</div><h1 className="font-serif text-3xl font-semibold">Your studio</h1></div>
    <div className="space-y-4">
      <div className="surface p-6 flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-gradient-to-br from-pink-400 to-indigo-400 flex items-center justify-center font-bold text-lg">{session?.user?.name?.[0]?.toUpperCase()||'U'}</div>
        <div className="flex-1"><div className="font-serif text-lg font-semibold">{session?.user?.name}</div><div className="text-sm text-muted-foreground">{session?.user?.email}</div></div>
      </div>
      <div className="surface p-6">
        <h3 className="font-serif text-lg font-semibold mb-3">Environment</h3>
        <div className="space-y-2 text-sm">
          <Row label="AI mode" value={process.env.OPENAI_API_KEY ? 'OpenAI connected' : 'Demo mode'}/>
          <Row label="Storage" value={process.env.STORAGE_PROVIDER==='cloudinary'?'Cloudinary':'Local disk'}/>
          <Row label="Queue" value={process.env.QUEUE_PROVIDER==='redis'?'Redis / BullMQ':'In-process'}/>
          <Row label="Database" value={process.env.DATABASE_URL?.includes('file:')?'SQLite':'PostgreSQL'}/>
        </div>
      </div>
      <form action="/api/auth/signout" method="post">
        <button formAction={()=>{import('next-auth/react').then(m=>m.signOut({callbackUrl:'/'}))}} className="btn-destructive w-full" type="button"><LogOut className="w-4 h-4"/> Sign out</button>
      </form>
    </div>
  </div>;
}
function Row({label,value}){return <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0"><span className="text-muted-foreground text-xs uppercase tracking-wider">{label}</span><span className="font-medium">{value}</span></div>;}
