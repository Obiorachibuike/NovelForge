# Model status report

Generated: 2026-10-21T23:10:35.056Z

> This report is generated from NovelForge's persisted model registry. "Configured" means the model ID is part of the requested registry; it does **not** mean the model is served by a hosted provider, reachable by this account, or free. Regenerate it after a verification run with `npm run ai:models:report`.

> **No Hugging Face token was configured when this report was generated.** Every model below is therefore unverified: no repository check, provider lookup or live inference was performed. Set `HF_TOKEN` and run `npm run ai:verify` to populate real statuses.

## Summary

| Metric | Count |
| --- | --- |
| Configured text models | 50 |
| Configured image models | 20 |
| Registered rows | 70 |
| Repositories verified on the Hub | 0 |
| Hosted inference supported | 0 |
| Successfully live-tested | 0 |
| Unavailable | 0 |
| Unsupported | 0 |
| Access/gating required | 0 |
| Paid only (availability) | 0 |
| Unverified | 70 |
| Pricing: confirmed free | 0 |
| Pricing: paid | 0 |
| Pricing: unknown | 70 |
| Enabled for selection | 70 |
| Disabled by an administrator | 0 |

## How to read the columns

- **Repository** — the Hub repository was found (metadata check).
- **Hosted** — a provider is mapped to the model for the required task (provider-mapping/router-catalog check).
- **Live test** — an actual inference request completed successfully. This is the only column that proves end-to-end operation.
- **Pricing** — `free`/`paid` come from provider pricing data; `unknown` is never treated as free.

## Text models (50)

| # | Model ID | Category | Repository | Hosted | Live test | Pricing | License | Last verified | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `CohereForAI/c4ai-command-r-plus` | Tier 1: Frontier / Ultra-Large Scale Models | not checked | not checked | not run | Unknown pricing | — | — | RAG-oriented model; hosted provider support must be verified. |
| 2 | `Qwen/Qwen2.5-72B-Instruct` | Tier 1: Frontier / Ultra-Large Scale Models | not checked | not checked | not run | Unknown pricing | — | — | — |
| 3 | `databricks/dbrx-instruct` | Tier 1: Frontier / Ultra-Large Scale Models | not checked | not checked | not run | Unknown pricing | — | — | Large MoE model; hosted provider support must be verified. |
| 4 | `deepseek-ai/DeepSeek-V3` | Tier 1: Frontier / Ultra-Large Scale Models | not checked | not checked | not run | Unknown pricing | — | — | — |
| 5 | `google/gemma-2-27b-it` | Tier 1: Frontier / Ultra-Large Scale Models | not checked | not checked | not run | Unknown pricing | — | — | Gated repository on the Hugging Face Hub: access must be accepted before inference. |
| 6 | `meta-llama/Llama-3.1-70B-Instruct` | Tier 1: Frontier / Ultra-Large Scale Models | not checked | not checked | not run | Unknown pricing | — | — | Gated repository on the Hugging Face Hub: access must be accepted before inference. |
| 7 | `meta-llama/Llama-3.3-70B-Instruct` | Tier 1: Frontier / Ultra-Large Scale Models | not checked | not checked | not run | Unknown pricing | — | — | Gated repository on the Hugging Face Hub: access must be accepted before inference. |
| 8 | `mistralai/Mixtral-8x22B-Instruct-v0.1` | Tier 1: Frontier / Ultra-Large Scale Models | not checked | not checked | not run | Unknown pricing | — | — | Sparse MoE; hosted provider support must be verified. |
| 9 | `01-AI/Yi-1.5-34B-Chat` | Tier 2: Mid-to-Large Mainstream Models | not checked | not checked | not run | Unknown pricing | — | — | — |
| 10 | `01-AI/Yi-34B-Chat` | Tier 2: Mid-to-Large Mainstream Models | not checked | not checked | not run | Unknown pricing | — | — | Superseded by Yi-1.5; hosted provider support must be verified. |
| 11 | `LiquidAI/LFM2.5-24B-A2B` | Tier 2: Mid-to-Large Mainstream Models | not checked | not checked | not run | Unknown pricing | — | — | Hybrid architecture; hosted provider support must be verified. |
| 12 | `Qwen/Qwen2.5-32B-Instruct` | Tier 2: Mid-to-Large Mainstream Models | not checked | not checked | not run | Unknown pricing | — | — | — |
| 13 | `mistralai/Mistral-Large-Instruct-2407` | Tier 2: Mid-to-Large Mainstream Models | not checked | not checked | not run | Unknown pricing | — | — | Older Mistral Large snapshot; hosted provider support must be verified. |
| 14 | `tencent/Hy-Memory-30B-A3B` | Tier 2: Mid-to-Large Mainstream Models | not checked | not checked | not run | Unknown pricing | — | — | Sparse MoE architecture; hosted provider support must be verified. |
| 15 | `tiiuae/falcon-40b-instruct` | Tier 2: Mid-to-Large Mainstream Models | not checked | not checked | not run | Unknown pricing | — | — | Older architecture; hosted provider support must be verified. |
| 16 | `upstage/SOLAR-10.7B-Instruct-v1.0` | Tier 2: Mid-to-Large Mainstream Models | not checked | not checked | not run | Unknown pricing | — | — | Depth-up-scaled 10.7B model; hosted provider support must be verified. |
| 17 | `HuggingFaceH4/zephyr-7b-beta` | Tier 3: Compact & High-Efficiency Workhorses | not checked | not checked | not run | Unknown pricing | — | — | DPO-tuned 7B chat model; short context limits chapter generation. |
| 18 | `Qwen/Qwen2.5-14B-Instruct` | Tier 3: Compact & High-Efficiency Workhorses | not checked | not checked | not run | Unknown pricing | — | — | — |
| 19 | `google/gemma-2-9b-it` | Tier 3: Compact & High-Efficiency Workhorses | not checked | not checked | not run | Unknown pricing | — | — | Gated repository on the Hugging Face Hub: access must be accepted before inference. |
| 20 | `ibm-granite/granite-3.0-8b-instruct` | Tier 3: Compact & High-Efficiency Workhorses | not checked | not checked | not run | Unknown pricing | — | — | Enterprise-oriented model; hosted provider support must be verified. |
| 21 | `meta-llama/Llama-3.1-8B-Instruct` | Tier 3: Compact & High-Efficiency Workhorses | not checked | not checked | not run | Unknown pricing | — | — | Gated repository on the Hugging Face Hub: access must be accepted before inference. |
| 22 | `microsoft/Phi-3.5-mini-instruct` | Tier 3: Compact & High-Efficiency Workhorses | not checked | not checked | not run | Unknown pricing | — | — | Small context window; unsuitable for long chapter generation with memory. |
| 23 | `mistralai/Mistral-7B-Instruct-v0.3` | Tier 3: Compact & High-Efficiency Workhorses | not checked | not checked | not run | Unknown pricing | — | — | — |
| 24 | `stabilityai/stablelm-2-12b-chat` | Tier 3: Compact & High-Efficiency Workhorses | not checked | not checked | not run | Unknown pricing | — | — | Hosted provider support must be verified. |
| 25 | `ConwayResearch/Underdog-Saluki-27B-1.0` | Tier 4: Small / Edge / Fast Deployment Models | not checked | not checked | not run | Unknown pricing | — | — | Community fine-tune; hosted provider support must be verified. |
| 26 | `Qwen/Qwen2.5-1.5B-Instruct` | Tier 4: Small / Edge / Fast Deployment Models | not checked | not checked | not run | Unknown pricing | — | — | 1.5B parameters — weak long-form narrative coherence; usable for short rewrites only. |
| 27 | `Qwen/Qwen2.5-3B-Instruct` | Tier 4: Small / Edge / Fast Deployment Models | not checked | not checked | not run | Unknown pricing | — | — | 3B parameters — limited long-form narrative coherence. |
| 28 | `Qwen/Qwen2.5-7B-Instruct` | Tier 4: Small / Edge / Fast Deployment Models | not checked | not checked | not run | Unknown pricing | — | — | — |
| 29 | `bespokelabs/Bespoke-Stratos-7B` | Tier 4: Small / Edge / Fast Deployment Models | not checked | not checked | not run | Unknown pricing | — | — | Reasoning-oriented fine-tune; verbose for prose generation. |
| 30 | `google/gemma-2-2b-it` | Tier 4: Small / Edge / Fast Deployment Models | not checked | not checked | not run | Unknown pricing | — | — | Gated repository on the Hugging Face Hub: access must be accepted before inference. |
| 31 | `jialinyyzz/humanizer` | Tier 4: Small / Edge / Fast Deployment Models | not checked | not checked | not run | Unknown pricing | — | — | — |
| 32 | `microsoft/Phi-3-mini-4k-instruct` | Tier 4: Small / Edge / Fast Deployment Models | not checked | not checked | not run | Unknown pricing | — | — | 4k context window — too small for long chapter prompts with story memory. |
| 33 | `Qwen/Qwen2.5-Coder-32B-Instruct` | Tier 5: Code Specialists | not checked | not checked | not run | Unknown pricing | — | — | Code-specialist model; not tuned for narrative prose. |
| 34 | `Qwen/Qwen2.5-Coder-7B-Instruct` | Tier 5: Code Specialists | not checked | not checked | not run | Unknown pricing | — | — | Code-specialist model; not tuned for narrative prose. |
| 35 | `deepseek-ai/DeepSeek-Coder-V2-Instruct` | Tier 5: Code Specialists | not checked | not checked | not run | Unknown pricing | — | — | Code-specialist model; not tuned for narrative prose. |
| 36 | `meta-llama/CodeLlama-34b-Instruct-hf` | Tier 5: Code Specialists | not checked | not checked | not run | Unknown pricing | — | — | Code-specialist model; not tuned for narrative prose. |
| 37 | `Nexusflow/Starling-LM-7B-beta` | Tier 6: Domain-Specific & Fine-Tunes | not checked | not checked | not run | Unknown pricing | — | — | Reward-model-trained chat model; provider support must be verified. |
| 38 | `NousResearch/Hermes-3-Llama-3.1-70B` | Tier 6: Domain-Specific & Fine-Tunes | not checked | not checked | not run | Unknown pricing | — | — | General fine-tune; hosted provider support must be verified. |
| 39 | `Salesforce/xLAM-70b-r` | Tier 6: Domain-Specific & Fine-Tunes | not checked | not checked | not run | Unknown pricing | — | — | Function-calling / agentic model; not tuned for narrative prose. |
| 40 | `allenai/Llama-3-Open-BioLLM-70B` | Tier 6: Domain-Specific & Fine-Tunes | not checked | not checked | not run | Unknown pricing | — | — | Biomedical domain model; not tuned for narrative prose. |
| 41 | `cognitivecomputations/dolphin-2.9.2-qwen2a-72b` | Tier 6: Domain-Specific & Fine-Tunes | not checked | not checked | not run | Unknown pricing | — | — | Uncensored fine-tune; review output policy before enabling. |
| 42 | `epfl-llm/meditron-70b` | Tier 6: Domain-Specific & Fine-Tunes | not checked | not checked | not run | Unknown pricing | — | — | Medical domain model; not tuned for narrative prose. |
| 43 | `nvidia/Llama-3-ChatQA-1.5-70B` | Tier 6: Domain-Specific & Fine-Tunes | not checked | not checked | not run | Unknown pricing | — | — | Question-answering model; not tuned for narrative prose. |
| 44 | `FreedomIntelligence/ALIENT-Model` | Tier 7: Global & Regional LLMs | not checked | not checked | not run | Unknown pricing | — | — | Repository availability and provider support must be verified. |
| 45 | `OpenLLM-France/Luciole-1B-Instruct` | Tier 7: Global & Regional LLMs | not checked | not checked | not run | Unknown pricing | — | — | 1B French-centric model; limited long-form English prose quality. |
| 46 | `SpeakLeash/bielik-7b-instruct-v0.1` | Tier 7: Global & Regional LLMs | not checked | not checked | not run | Unknown pricing | — | — | Polish-centric model; hosted provider support must be verified. |
| 47 | `cyberagent/calm3-22b-chat` | Tier 7: Global & Regional LLMs | not checked | not checked | not run | Unknown pricing | — | — | Japanese-centric model; hosted provider support must be verified. |
| 48 | `fblgit/ESTHER-7B` | Tier 7: Global & Regional LLMs | not checked | not checked | not run | Unknown pricing | — | — | Repository availability and provider support must be verified. |
| 49 | `lightblue/suzume-llama-3-8b-bmt` | Tier 7: Global & Regional LLMs | not checked | not checked | not run | Unknown pricing | — | — | Community fine-tune; hosted provider support must be verified. |
| 50 | `utter-project/EuroLLM-9B-Instruct` | Tier 7: Global & Regional LLMs | not checked | not checked | not run | Unknown pricing | — | — | Multilingual European model; hosted provider support must be verified. |

## Image models (20)

| # | Model ID | Category | Repository | Hosted | Live test | Pricing | License | Last verified | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `XLabs-AI/flux-RealismLora` | Tier 1: FLUX Architecture Family | not checked | not checked | not run | Unknown pricing | — | — | Publishes LoRA adapter weights for a FLUX base model, not a standalone text-to-image pipeline. Cannot be called as a base model through hosted inference; an adapter-capable provider and a base model are required. |
| 2 | `black-forest-labs/FLUX.1-dev` | Tier 1: FLUX Architecture Family | not checked | not checked | not run | Unknown pricing | — | — | Gated repository on the Hugging Face Hub: access must be accepted before inference. |
| 3 | `black-forest-labs/FLUX.1-schnell` | Tier 1: FLUX Architecture Family | not checked | not checked | not run | Unknown pricing | — | — | — |
| 4 | `black-forest-labs/flux-3-image-klein` | Tier 1: FLUX Architecture Family | not checked | not checked | not run | Unknown pricing | — | — | Repository availability and provider support must be verified before use. |
| 5 | `OpenMOSS-Team/MOSS-Image-Base` | Tier 2: Qwen & Asian Multimodal Image Models | not checked | not checked | not run | Unknown pricing | — | — | Repository availability and provider support must be verified before use. |
| 6 | `OpenMOSS-Team/MOSS-Image-SFT` | Tier 2: Qwen & Asian Multimodal Image Models | not checked | not checked | not run | Unknown pricing | — | — | Repository availability and provider support must be verified before use. |
| 7 | `Qwen/Qwen-Image-2.1` | Tier 2: Qwen & Asian Multimodal Image Models | not checked | not checked | not run | Unknown pricing | — | — | Repository availability and provider support must be verified before use. |
| 8 | `Qwen/Qwen-Image-2.1-Turbo` | Tier 2: Qwen & Asian Multimodal Image Models | not checked | not checked | not run | Unknown pricing | — | — | Repository availability and provider support must be verified before use. |
| 9 | `runwayml/stable-diffusion-v1-5` | Tier 3: Stable Diffusion SDXL / SD3 Family | not checked | not checked | not run | Unknown pricing | — | — | — |
| 10 | `stabilityai/stable-diffusion-3.5-large-turbo` | Tier 3: Stable Diffusion SDXL / SD3 Family | not checked | not checked | not run | Unknown pricing | — | — | Gated repository on the Hugging Face Hub: access must be accepted before inference. |
| 11 | `stabilityai/stable-diffusion-3.5-medium` | Tier 3: Stable Diffusion SDXL / SD3 Family | not checked | not checked | not run | Unknown pricing | — | — | Gated repository on the Hugging Face Hub: access must be accepted before inference. |
| 12 | `stabilityai/stable-diffusion-xl-base-1.0` | Tier 3: Stable Diffusion SDXL / SD3 Family | not checked | not checked | not run | Unknown pricing | — | — | — |
| 13 | `Lykon/dreamshaper-xl-1-0` | Tier 4: Realism & Style Specialists | not checked | not checked | not run | Unknown pricing | — | — | — |
| 14 | `SG161222/RealVisXL_V4.0` | Tier 4: Realism & Style Specialists | not checked | not checked | not run | Unknown pricing | — | — | — |
| 15 | `cagliostrolab/animagine-xl-3.1` | Tier 4: Realism & Style Specialists | not checked | not checked | not run | Unknown pricing | — | — | — |
| 16 | `prompthero/openjourney-v4` | Tier 4: Realism & Style Specialists | not checked | not checked | not run | Unknown pricing | — | — | — |
| 17 | `ByteDance/SDXL-Lightning` | Tier 5: Fast Lightning / Distilled Models | not checked | not checked | not run | Unknown pricing | — | — | Distilled SDXL checkpoint; published as LoRA/checkpoint variants that must match the base SDXL pipeline and step budget. |
| 18 | `DeepFloyd/IF-I-XL-v1.0` | Tier 5: Fast Lightning / Distilled Models | not checked | not checked | not run | Unknown pricing | — | — | Stage I of a cascaded pipeline (IF-I to IF-II to upscaler); a single hosted text-to-image call returns a low-resolution image. |
| 19 | `kandinsky-community/kandinsky-3` | Tier 5: Fast Lightning / Distilled Models | not checked | not checked | not run | Unknown pricing | — | — | Requires the Kandinsky 3 pipeline; not all text-to-image providers implement it. |
| 20 | `pixart-alpha/PixArt-sigma-xl2-1024-MS` | Tier 5: Fast Lightning / Distilled Models | not checked | not checked | not run | Unknown pricing | — | — | Requires the PixArt-Sigma pipeline; support varies by provider. |

## Notes on specific model architectures

- **Adapters / LoRA weights** (for example `XLabs-AI/flux-RealismLora`) are not standalone text-to-image models. NovelForge keeps the requested ID, records the adapter metadata reported by the provider mapping, and marks the model as needing a base model. Adapter composition is only attempted when the hosted provider actually supports it.
- **Cascaded pipelines** (for example `DeepFloyd/IF-I-XL-v1.0`) return a low-resolution stage-I image from a single hosted call.
- **Gated repositories** (Llama, Gemma, FLUX.1-dev, SD3.5) require the account to accept the model terms before inference is possible.
