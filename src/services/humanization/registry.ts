/** Humanization candidates — Agnes AI is now primary; HF models kept for legacy compatibility. */
export type Verification = 'unverified' | 'verified' | 'unavailable';
export interface HumanizerModel {
  id: string; name: string; category: 'dedicated-humanizer' | 'general-purpose'; languages: string[];
  license: string | null; size: string | null; inference: string;
  status: Verification; recommendedWords: number; novelSuitable: boolean; note: string;
}
const candidates = [
  ['agnes-2.5-flash','Agnes 2.5 Flash','general-purpose',180,'Primary Agnes model for humanization — high quality, 512K context.'],
  ['agnes-3.0-flash','Agnes 3.0 Flash','general-purpose',180,'Next-gen Agnes flagship for rewrite tasks.'],
  ['agnes-2.0-flash','Agnes 2.0 Flash','general-purpose',180,'Standard Agnes model for rewrite.'],
  ['agnes-1.5-flash','Agnes 1.5 Flash','general-purpose',160,'Fast Agnes model for low-latency rewrites.'],
  ['gohumanize/gohumanize-open-humanizer','GoHumanize Open Humanizer','dedicated-humanizer',180,'Legacy dedicated rewrite model (HF).'],
  ['jialinyyzz/humanizer','Humanizer','dedicated-humanizer',180,'Legacy HF humanizer candidate.'],
] as const;
export const humanizerModels: HumanizerModel[] = candidates.map(([id,name,category,recommendedWords,note]) => ({id,name,category:category as any,languages:['en'],license:null,size:null,inference:'Agnes AI / legacy HF',status:'unverified',recommendedWords:recommendedWords as number,novelSuitable:true,note:note as string}));
export const DEFAULT_HUMANIZER_MODEL='agnes-2.5-flash';
export function getHumanizerModel(id:string) { return humanizerModels.find(m=>m.id===id); }
