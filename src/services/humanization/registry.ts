/** Humanization candidates are deliberately marked unverified until Hub metadata and a live inference call have succeeded. */
export type Verification = 'unverified' | 'verified' | 'unavailable';
export interface HumanizerModel {
  id: string; name: string; category: 'dedicated-humanizer' | 'general-purpose'; languages: string[];
  license: string | null; size: string | null; inference: 'HF Inference Providers / configured endpoint';
  status: Verification; recommendedWords: number; novelSuitable: boolean; note: string;
}
const candidates = [
  ['gohumanize/gohumanize-open-humanizer','GoHumanize Open Humanizer','dedicated-humanizer',180,'Dedicated rewrite model; hosted support and license must be verified.'],
  ['Lynote/humanize-text-model','Lynote Humanize Text','dedicated-humanizer',180,'Dedicated humanization candidate; availability unverified.'],
  ['ericthewiz/humanizer','Humanizer','dedicated-humanizer',180,'Dedicated humanization candidate; availability unverified.'],
  ['lackey43/humanizer','Humanizer','dedicated-humanizer',180,'Dedicated humanization candidate; availability unverified.'],
  ['jialinyyzz/humanizer','Humanizer','dedicated-humanizer',180,'Dedicated humanization candidate; availability unverified.'],
  ['npario/humanizer','Humanizer','dedicated-humanizer',180,'Dedicated humanization candidate; availability unverified.'],
  ['DeFactOfficial/humanizer-qwen3.6-27b-lora','Humanizer Qwen LoRA','dedicated-humanizer',180,'Fine-tuned candidate; hardware and hosted support unverified.'],
  ['cive202/humanize-ai-text-bart-large','Humanize AI Text BART Large','dedicated-humanizer',120,'Encoder-decoder candidate; hosted support unverified.'],
  ['cive202/humanize-ai-text-bart-base','Humanize AI Text BART Base','dedicated-humanizer',120,'Encoder-decoder candidate; hosted support unverified.'],
  ['cive202/humanize-ai-text-mistral-7b-lora','Humanize AI Text Mistral LoRA','dedicated-humanizer',160,'Fine-tuned candidate; hosted support unverified.'],
  ['Qwen/Qwen2.5-7B-Instruct','Qwen 2.5 7B Instruct','general-purpose',180,'General-purpose rewrite alternative, not a dedicated humanizer.'],
  ['mistralai/Mistral-7B-Instruct-v0.3','Mistral 7B Instruct','general-purpose',180,'General-purpose rewrite alternative, not a dedicated humanizer.'],
  ['HuggingFaceH4/zephyr-7b-beta','Zephyr 7B Beta','general-purpose',180,'General-purpose rewrite alternative, not a dedicated humanizer.'],
  ['google/gemma-2-2b-it','Gemma 2 2B IT','general-purpose',140,'General-purpose alternative; gated access may apply.'],
  ['Qwen/Qwen2.5-3B-Instruct','Qwen 2.5 3B Instruct','general-purpose',150,'General-purpose alternative; coherence may be limited.'],
  ['Qwen/Qwen2.5-14B-Instruct','Qwen 2.5 14B Instruct','general-purpose',180,'General-purpose rewrite alternative, not a dedicated humanizer.'],
  ['microsoft/Phi-3.5-mini-instruct','Phi 3.5 Mini Instruct','general-purpose',140,'General-purpose rewrite alternative, not a dedicated humanizer.'],
  ['google/gemma-2-9b-it','Gemma 2 9B IT','general-purpose',180,'General-purpose alternative; gated access may apply.'],
  ['NousResearch/Hermes-3-Llama-3.1-8B','Hermes 3 Llama 3.1 8B','general-purpose',180,'General-purpose rewrite alternative; repository verification required.'],
  ['microsoft/Phi-3-mini-4k-instruct','Phi 3 Mini 4K Instruct','general-purpose',100,'General-purpose alternative; short context limits context.'],
] as const;
export const humanizerModels: HumanizerModel[] = candidates.map(([id,name,category,recommendedWords,note]) => ({id,name,category,languages:['en'],license:null,size:null,inference:'HF Inference Providers / configured endpoint',status:'unverified',recommendedWords,novelSuitable:category==='dedicated-humanizer',note}));
export const DEFAULT_HUMANIZER_MODEL='gohumanize/gohumanize-open-humanizer';
export function getHumanizerModel(id:string) { return humanizerModels.find(m=>m.id===id); }
