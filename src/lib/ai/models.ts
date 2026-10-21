/**
 * The NovelForge model registry: the exact configured model identifiers.
 *
 * IMPORTANT — accuracy rules enforced across the codebase:
 *  - These IDs are *configured*, not proven. Presence in this file says nothing
 *    about whether a hosted provider serves the model, whether the account can
 *    reach it, or whether inference is free.
 *  - `availabilityStatus` starts as `unverified` and `pricingStatus` as
 *    `unknown` for every entry. Only the verification service (or a successful
 *    live inference) may promote them.
 *  - IDs are never rewritten, normalised or substituted. If a repository turns
 *    out to be a LoRA, a checkpoint or an unsupported architecture, the entry
 *    stays and the limitation is recorded against it.
 */
import type { ImageModelMetadata, TextModelMetadata } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Text-to-text registry (50 models)
// ─────────────────────────────────────────────────────────────────────────────

export const TEXT_MODEL_CATEGORIES = {
  'Tier 1: Frontier / Ultra-Large Scale Models': [
    'deepseek-ai/DeepSeek-V3',
    'Qwen/Qwen2.5-72B-Instruct',
    'meta-llama/Llama-3.1-70B-Instruct',
    'meta-llama/Llama-3.3-70B-Instruct',
    'mistralai/Mixtral-8x22B-Instruct-v0.1',
    'google/gemma-2-27b-it',
    'CohereForAI/c4ai-command-r-plus',
    'databricks/dbrx-instruct',
  ],
  'Tier 2: Mid-to-Large Mainstream Models': [
    'Qwen/Qwen2.5-32B-Instruct',
    'mistralai/Mistral-Large-Instruct-2407',
    '01-AI/Yi-1.5-34B-Chat',
    '01-AI/Yi-34B-Chat',
    'tiiuae/falcon-40b-instruct',
    'upstage/SOLAR-10.7B-Instruct-v1.0',
    'tencent/Hy-Memory-30B-A3B',
    'LiquidAI/LFM2.5-24B-A2B',
  ],
  'Tier 3: Compact & High-Efficiency Workhorses': [
    'Qwen/Qwen2.5-14B-Instruct',
    'meta-llama/Llama-3.1-8B-Instruct',
    'mistralai/Mistral-7B-Instruct-v0.3',
    'google/gemma-2-9b-it',
    'microsoft/Phi-3.5-mini-instruct',
    'ibm-granite/granite-3.0-8b-instruct',
    'stabilityai/stablelm-2-12b-chat',
    'HuggingFaceH4/zephyr-7b-beta',
  ],
  'Tier 4: Small / Edge / Fast Deployment Models': [
    'Qwen/Qwen2.5-7B-Instruct',
    'Qwen/Qwen2.5-3B-Instruct',
    'Qwen/Qwen2.5-1.5B-Instruct',
    'google/gemma-2-2b-it',
    'microsoft/Phi-3-mini-4k-instruct',
    'jialinyyzz/humanizer',
    'ConwayResearch/Underdog-Saluki-27B-1.0',
    'bespokelabs/Bespoke-Stratos-7B',
  ],
  'Tier 5: Code Specialists': [
    'deepseek-ai/DeepSeek-Coder-V2-Instruct',
    'Qwen/Qwen2.5-Coder-32B-Instruct',
    'Qwen/Qwen2.5-Coder-7B-Instruct',
    'meta-llama/CodeLlama-34b-Instruct-hf',
  ],
  'Tier 6: Domain-Specific & Fine-Tunes': [
    'cognitivecomputations/dolphin-2.9.2-qwen2a-72b',
    'NousResearch/Hermes-3-Llama-3.1-70B',
    'Nexusflow/Starling-LM-7B-beta',
    'allenai/Llama-3-Open-BioLLM-70B',
    'nvidia/Llama-3-ChatQA-1.5-70B',
    'Salesforce/xLAM-70b-r',
    'epfl-llm/meditron-70b',
  ],
  'Tier 7: Global & Regional LLMs': [
    'FreedomIntelligence/ALIENT-Model',
    'SpeakLeash/bielik-7b-instruct-v0.1',
    'cyberagent/calm3-22b-chat',
    'lightblue/suzume-llama-3-8b-bmt',
    'utter-project/EuroLLM-9B-Instruct',
    'OpenLLM-France/Luciole-1B-Instruct',
    'fblgit/ESTHER-7B',
  ],
} as const;

export const textToTextModels = [
  // Tier 1: Frontier / Ultra-Large Scale Models
  'deepseek-ai/DeepSeek-V3',
  'Qwen/Qwen2.5-72B-Instruct',
  'meta-llama/Llama-3.1-70B-Instruct',
  'meta-llama/Llama-3.3-70B-Instruct',
  'mistralai/Mixtral-8x22B-Instruct-v0.1',
  'google/gemma-2-27b-it',
  'CohereForAI/c4ai-command-r-plus',
  'databricks/dbrx-instruct',

  // Tier 2: Mid-to-Large Mainstream Models
  'Qwen/Qwen2.5-32B-Instruct',
  'mistralai/Mistral-Large-Instruct-2407',
  '01-AI/Yi-1.5-34B-Chat',
  '01-AI/Yi-34B-Chat',
  'tiiuae/falcon-40b-instruct',
  'upstage/SOLAR-10.7B-Instruct-v1.0',
  'tencent/Hy-Memory-30B-A3B',
  'LiquidAI/LFM2.5-24B-A2B',

  // Tier 3: Compact & High-Efficiency Workhorses
  'Qwen/Qwen2.5-14B-Instruct',
  'meta-llama/Llama-3.1-8B-Instruct',
  'mistralai/Mistral-7B-Instruct-v0.3',
  'google/gemma-2-9b-it',
  'microsoft/Phi-3.5-mini-instruct',
  'ibm-granite/granite-3.0-8b-instruct',
  'stabilityai/stablelm-2-12b-chat',
  'HuggingFaceH4/zephyr-7b-beta',

  // Tier 4: Small / Edge / Fast Deployment Models
  'Qwen/Qwen2.5-7B-Instruct',
  'Qwen/Qwen2.5-3B-Instruct',
  'Qwen/Qwen2.5-1.5B-Instruct',
  'google/gemma-2-2b-it',
  'microsoft/Phi-3-mini-4k-instruct',
  'jialinyyzz/humanizer',
  'ConwayResearch/Underdog-Saluki-27B-1.0',
  'bespokelabs/Bespoke-Stratos-7B',

  // Tier 5: Code Specialists
  'deepseek-ai/DeepSeek-Coder-V2-Instruct',
  'Qwen/Qwen2.5-Coder-32B-Instruct',
  'Qwen/Qwen2.5-Coder-7B-Instruct',
  'meta-llama/CodeLlama-34b-Instruct-hf',

  // Tier 6: Domain-Specific & Fine-Tunes
  'cognitivecomputations/dolphin-2.9.2-qwen2a-72b',
  'NousResearch/Hermes-3-Llama-3.1-70B',
  'Nexusflow/Starling-LM-7B-beta',
  'allenai/Llama-3-Open-BioLLM-70B',
  'nvidia/Llama-3-ChatQA-1.5-70B',
  'Salesforce/xLAM-70b-r',
  'epfl-llm/meditron-70b',

  // Tier 7: Global & Regional LLMs
  'FreedomIntelligence/ALIENT-Model',
  'SpeakLeash/bielik-7b-instruct-v0.1',
  'cyberagent/calm3-22b-chat',
  'lightblue/suzume-llama-3-8b-bmt',
  'utter-project/EuroLLM-9B-Instruct',
  'OpenLLM-France/Luciole-1B-Instruct',
  'fblgit/ESTHER-7B',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Text-to-image registry (20 models)
// ─────────────────────────────────────────────────────────────────────────────

export const IMAGE_MODEL_CATEGORIES = {
  'Tier 1: FLUX Architecture Family': [
    'black-forest-labs/FLUX.1-dev',
    'black-forest-labs/FLUX.1-schnell',
    'black-forest-labs/flux-3-image-klein',
    'XLabs-AI/flux-RealismLora',
  ],
  'Tier 2: Qwen & Asian Multimodal Image Models': [
    'Qwen/Qwen-Image-2.1-Turbo',
    'Qwen/Qwen-Image-2.1',
    'OpenMOSS-Team/MOSS-Image-Base',
    'OpenMOSS-Team/MOSS-Image-SFT',
  ],
  'Tier 3: Stable Diffusion SDXL / SD3 Family': [
    'stabilityai/stable-diffusion-3.5-large-turbo',
    'stabilityai/stable-diffusion-3.5-medium',
    'stabilityai/stable-diffusion-xl-base-1.0',
    'runwayml/stable-diffusion-v1-5',
  ],
  'Tier 4: Realism & Style Specialists': [
    'SG161222/RealVisXL_V4.0',
    'Lykon/dreamshaper-xl-1-0',
    'prompthero/openjourney-v4',
    'cagliostrolab/animagine-xl-3.1',
  ],
  'Tier 5: Fast Lightning / Distilled Models': [
    'ByteDance/SDXL-Lightning',
    'kandinsky-community/kandinsky-3',
    'pixart-alpha/PixArt-sigma-xl2-1024-MS',
    'DeepFloyd/IF-I-XL-v1.0',
  ],
} as const;

export const textToImageModels = [
  // Tier 1: FLUX Architecture Family
  'black-forest-labs/FLUX.1-dev',
  'black-forest-labs/FLUX.1-schnell',
  'black-forest-labs/flux-3-image-klein',
  'XLabs-AI/flux-RealismLora',

  // Tier 2: Qwen & Asian Multimodal Image Models
  'Qwen/Qwen-Image-2.1-Turbo',
  'Qwen/Qwen-Image-2.1',
  'OpenMOSS-Team/MOSS-Image-Base',
  'OpenMOSS-Team/MOSS-Image-SFT',

  // Tier 3: Stable Diffusion SDXL / SD3 Family
  'stabilityai/stable-diffusion-3.5-large-turbo',
  'stabilityai/stable-diffusion-3.5-medium',
  'stabilityai/stable-diffusion-xl-base-1.0',
  'runwayml/stable-diffusion-v1-5',

  // Tier 4: Realism & Style Specialists
  'SG161222/RealVisXL_V4.0',
  'Lykon/dreamshaper-xl-1-0',
  'prompthero/openjourney-v4',
  'cagliostrolab/animagine-xl-3.1',

  // Tier 5: Fast Lightning / Distilled Models
  'ByteDance/SDXL-Lightning',
  'kandinsky-community/kandinsky-3',
  'pixart-alpha/PixArt-sigma-xl2-1024-MS',
  'DeepFloyd/IF-I-XL-v1.0',
] as const;

export const EXPECTED_TEXT_MODEL_COUNT = 50;
export const EXPECTED_IMAGE_MODEL_COUNT = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Static, honest per-model notes.
//
// Only facts that are true from the repository's own documentation and do not
// require a live check belong here (e.g. "this repository publishes LoRA
// adapter weights, not a standalone pipeline"). Everything else — hosted
// provider support, pricing, gating — is discovered by the verification service.
// ─────────────────────────────────────────────────────────────────────────────

const STATIC_LIMITATIONS: Record<string, string[]> = {
  // Adapter / LoRA weights — not a standalone text-to-image pipeline.
  'XLabs-AI/flux-RealismLora': [
    'Publishes LoRA adapter weights for a FLUX base model, not a standalone text-to-image pipeline.',
    'Cannot be called as a base model through hosted inference; an adapter-capable provider and a base model are required.',
  ],
  // Checkpoints that need a specific pipeline, or a particular base model.
  'DeepFloyd/IF-I-XL-v1.0': [
    'Stage I of a cascaded pipeline (IF-I to IF-II to upscaler); a single hosted text-to-image call returns a low-resolution image.',
  ],
  'ByteDance/SDXL-Lightning': [
    'Distilled SDXL checkpoint; published as LoRA/checkpoint variants that must match the base SDXL pipeline and step budget.',
  ],
  'kandinsky-community/kandinsky-3': [
    'Requires the Kandinsky 3 pipeline; not all text-to-image providers implement it.',
  ],
  'pixart-alpha/PixArt-sigma-xl2-1024-MS': [
    'Requires the PixArt-Sigma pipeline; support varies by provider.',
  ],
  'Qwen/Qwen-Image-2.1-Turbo': ['Repository availability and provider support must be verified before use.'],
  'Qwen/Qwen-Image-2.1': ['Repository availability and provider support must be verified before use.'],
  'OpenMOSS-Team/MOSS-Image-Base': ['Repository availability and provider support must be verified before use.'],
  'OpenMOSS-Team/MOSS-Image-SFT': ['Repository availability and provider support must be verified before use.'],
  'black-forest-labs/flux-3-image-klein': ['Repository availability and provider support must be verified before use.'],
  'microsoft/Phi-3-mini-4k-instruct': ['4k context window — too small for long chapter prompts with story memory.'],
  'microsoft/Phi-3.5-mini-instruct': ['Small context window; unsuitable for long chapter generation with memory.'],
  'Qwen/Qwen2.5-1.5B-Instruct': ['1.5B parameters — weak long-form narrative coherence; usable for short rewrites only.'],
  'Qwen/Qwen2.5-3B-Instruct': ['3B parameters — limited long-form narrative coherence.'],
  'ConwayResearch/Underdog-Saluki-27B-1.0': ['Community fine-tune; hosted provider support must be verified.'],
  'bespokelabs/Bespoke-Stratos-7B': ['Reasoning-oriented fine-tune; verbose for prose generation.'],
  'tencent/Hy-Memory-30B-A3B': ['Sparse MoE architecture; hosted provider support must be verified.'],
  'LiquidAI/LFM2.5-24B-A2B': ['Hybrid architecture; hosted provider support must be verified.'],
  'FreedomIntelligence/ALIENT-Model': ['Repository availability and provider support must be verified.'],
  'fblgit/ESTHER-7B': ['Repository availability and provider support must be verified.'],
  'lightblue/suzume-llama-3-8b-bmt': ['Community fine-tune; hosted provider support must be verified.'],
  'cyberagent/calm3-22b-chat': ['Japanese-centric model; hosted provider support must be verified.'],
  'utter-project/EuroLLM-9B-Instruct': ['Multilingual European model; hosted provider support must be verified.'],
  'OpenLLM-France/Luciole-1B-Instruct': ['1B French-centric model; limited long-form English prose quality.'],
  'SpeakLeash/bielik-7b-instruct-v0.1': ['Polish-centric model; hosted provider support must be verified.'],
  'Salesforce/xLAM-70b-r': ['Function-calling / agentic model; not tuned for narrative prose.'],
  'nvidia/Llama-3-ChatQA-1.5-70B': ['Question-answering model; not tuned for narrative prose.'],
  'allenai/Llama-3-Open-BioLLM-70B': ['Biomedical domain model; not tuned for narrative prose.'],
  'epfl-llm/meditron-70b': ['Medical domain model; not tuned for narrative prose.'],
  'meta-llama/CodeLlama-34b-Instruct-hf': ['Code-specialist model; not tuned for narrative prose.'],
  'deepseek-ai/DeepSeek-Coder-V2-Instruct': ['Code-specialist model; not tuned for narrative prose.'],
  'Qwen/Qwen2.5-Coder-32B-Instruct': ['Code-specialist model; not tuned for narrative prose.'],
  'Qwen/Qwen2.5-Coder-7B-Instruct': ['Code-specialist model; not tuned for narrative prose.'],
  'Nexusflow/Starling-LM-7B-beta': ['Reward-model-trained chat model; provider support must be verified.'],
  'cognitivecomputations/dolphin-2.9.2-qwen2a-72b': ['Uncensored fine-tune; review output policy before enabling.'],
  'NousResearch/Hermes-3-Llama-3.1-70B': ['General fine-tune; hosted provider support must be verified.'],
  'databricks/dbrx-instruct': ['Large MoE model; hosted provider support must be verified.'],
  'CohereForAI/c4ai-command-r-plus': ['RAG-oriented model; hosted provider support must be verified.'],
  'tiiuae/falcon-40b-instruct': ['Older architecture; hosted provider support must be verified.'],
  '01-AI/Yi-34B-Chat': ['Superseded by Yi-1.5; hosted provider support must be verified.'],
  'stabilityai/stablelm-2-12b-chat': ['Hosted provider support must be verified.'],
  'HuggingFaceH4/zephyr-7b-beta': ['DPO-tuned 7B chat model; short context limits chapter generation.'],
  'ibm-granite/granite-3.0-8b-instruct': ['Enterprise-oriented model; hosted provider support must be verified.'],
  'upstage/SOLAR-10.7B-Instruct-v1.0': ['Depth-up-scaled 10.7B model; hosted provider support must be verified.'],
  'mistralai/Mixtral-8x22B-Instruct-v0.1': ['Sparse MoE; hosted provider support must be verified.'],
  'mistralai/Mistral-Large-Instruct-2407': ['Older Mistral Large snapshot; hosted provider support must be verified.'],
  'google/gemma-2-27b-it': ['Gated repository on the Hugging Face Hub: access must be accepted before inference.'],
  'google/gemma-2-9b-it': ['Gated repository on the Hugging Face Hub: access must be accepted before inference.'],
  'google/gemma-2-2b-it': ['Gated repository on the Hugging Face Hub: access must be accepted before inference.'],
  'meta-llama/Llama-3.1-70B-Instruct': ['Gated repository on the Hugging Face Hub: access must be accepted before inference.'],
  'meta-llama/Llama-3.3-70B-Instruct': ['Gated repository on the Hugging Face Hub: access must be accepted before inference.'],
  'meta-llama/Llama-3.1-8B-Instruct': ['Gated repository on the Hugging Face Hub: access must be accepted before inference.'],
  'stabilityai/stable-diffusion-3.5-large-turbo': ['Gated repository on the Hugging Face Hub: access must be accepted before inference.'],
  'stabilityai/stable-diffusion-3.5-medium': ['Gated repository on the Hugging Face Hub: access must be accepted before inference.'],
  'black-forest-labs/FLUX.1-dev': ['Gated repository on the Hugging Face Hub: access must be accepted before inference.'],
};

/** Human-friendly display name derived from the exact model id. */
export function displayNameFor(modelId: string): string {
  const [, name] = modelId.split('/');
  return name || modelId;
}

function categoryFor(modelId: string, groups: Record<string, readonly string[]>): string {
  for (const [category, ids] of Object.entries(groups)) {
    if ((ids as readonly string[]).map(String).indexOf(modelId) !== -1) return category;
  }
  return 'Uncategorised';
}

/** Builds the default (unverified) metadata for every configured text model. */
export function buildTextModelMetadata(): TextModelMetadata[] {
  return textToTextModels.map(id => ({
    id,
    name: displayNameFor(id),
    category: categoryFor(id, TEXT_MODEL_CATEGORIES as unknown as Record<string, readonly string[]>),
    task: 'text-generation' as const,
    // Enabled in the registry, but *not* usable until verification or a live
    // success flips availability away from `unverified` — see model-selection.
    enabled: true,
    verified: false,
    availabilityStatus: 'unverified' as const,
    pricingStatus: 'unknown' as const,
    failureCount: 0,
    successCount: 0,
    limitations: STATIC_LIMITATIONS[id] ?? [],
    verificationSource: 'unverified' as const,
  }));
}

/** Builds the default (unverified) metadata for every configured image model. */
export function buildImageModelMetadata(): ImageModelMetadata[] {
  return textToImageModels.map(id => ({
    id,
    name: displayNameFor(id),
    category: categoryFor(id, IMAGE_MODEL_CATEGORIES as unknown as Record<string, readonly string[]>),
    task: 'text-to-image' as const,
    enabled: true,
    verified: false,
    availabilityStatus: 'unverified' as const,
    pricingStatus: 'unknown' as const,
    failureCount: 0,
    successCount: 0,
    limitations: STATIC_LIMITATIONS[id] ?? [],
    verificationSource: 'unverified' as const,
  }));
}

const TEXT_IDS = new Set<string>(textToTextModels as readonly string[]);
const IMAGE_IDS = new Set<string>(textToImageModels as readonly string[]);
export const ALL_MODEL_IDS: string[] = [...(textToTextModels as readonly string[]), ...(textToImageModels as readonly string[])];

export function isRegisteredModelId(id: string): boolean {
  return TEXT_IDS.has(id) || IMAGE_IDS.has(id);
}

export function taskForModelId(id: string): 'text-generation' | 'text-to-image' | null {
  if (TEXT_IDS.has(id)) return 'text-generation';
  if (IMAGE_IDS.has(id)) return 'text-to-image';
  return null;
}

export function limitationFor(id: string): string[] {
  return STATIC_LIMITATIONS[id] ?? [];
}

/**
 * Registry integrity check used by tests and by startup validation. Returns a
 * list of human-readable problems (empty when the registry is intact).
 */
export function validateRegistries(): string[] {
  const problems: string[] = [];
  const text = textToTextModels as readonly string[];
  const image = textToImageModels as readonly string[];

  if (text.length !== EXPECTED_TEXT_MODEL_COUNT) {
    problems.push(`Expected ${EXPECTED_TEXT_MODEL_COUNT} text models, found ${text.length}.`);
  }
  if (image.length !== EXPECTED_IMAGE_MODEL_COUNT) {
    problems.push(`Expected ${EXPECTED_IMAGE_MODEL_COUNT} image models, found ${image.length}.`);
  }
  if (new Set(text).size !== text.length) problems.push('Duplicate text model IDs in the registry.');
  if (new Set(image).size !== image.length) problems.push('Duplicate image model IDs in the registry.');
  const overlap = text.filter(id => IMAGE_IDS.has(id));
  if (overlap.length) problems.push(`Model IDs present in both registries: ${overlap.join(', ')}.`);
  for (const id of [...text, ...image]) {
    if (!/^[^/]+\/[^/]+$/.test(id)) problems.push(`Model ID "${id}" is not in "owner/name" form.`);
  }
  const categorisedText: string[] = Object.values(TEXT_MODEL_CATEGORIES).flat().map(String);
  const categorisedImage: string[] = Object.values(IMAGE_MODEL_CATEGORIES).flat().map(String);
  for (const id of text) if (!categorisedText.includes(id)) problems.push(`Text model ${id} has no category.`);
  for (const id of image) if (!categorisedImage.includes(id)) problems.push(`Image model ${id} has no category.`);
  return problems;
}
