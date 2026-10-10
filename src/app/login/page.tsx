import LoginClient from './LoginClient';
export default function LoginPage() {
  return (
    <div className="min-h-screen bg-[#05070D] grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between p-12 bg-gradient-to-br from-indigo-950/40 to-violet-950/30 border-r border-white/5 relative overflow-hidden">
        <div className="absolute -top-20 -left-20 w-[400px] h-[400px] bg-indigo-500/20 rounded-full blur-3xl" />
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-900/50"><span className="font-serif text-lg font-bold">NF</span></div>
          <div><div className="font-serif text-xl font-semibold">NovelForge</div><div className="text-[10px] font-mono tracking-widest text-slate-400">WRITING STUDIO</div></div>
        </div>
        <div className="relative z-10">
          <h2 className="font-serif text-4xl leading-tight font-semibold mb-4">“The crown was never lost. It was waiting for the right hands to find it.”</h2>
          <p className="text-slate-400 font-serif italic">— The Last Kingdom, Chapter 4</p>
        </div>
        <div className="relative z-10 text-xs text-slate-500">One chapter at a time. Always under your control.</div>
      </div>
      <div className="flex items-center justify-center p-8"><LoginClient/></div>
    </div>
  );
}
