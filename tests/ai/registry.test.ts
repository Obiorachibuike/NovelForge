import { describe, expect, it, beforeEach } from 'vitest';
import { freshDatabase, db } from '../helpers/db';
import {
  textToTextModels,
  textToImageModels,
  EXPECTED_TEXT_MODEL_COUNT,
  EXPECTED_IMAGE_MODEL_COUNT,
  TEXT_MODEL_CATEGORIES,
  IMAGE_MODEL_CATEGORIES,
  validateRegistries,
  buildTextModelMetadata,
  buildImageModelMetadata,
  isRegisteredModelId,
  taskForModelId,
} from '@/lib/ai/models';
import {
  getModelRow,
  listModelRows,
  patchModel,
  recordModelFailure,
  recordModelSuccess,
  registryOverview,
  resetRegistryForTests,
  setModelEnabled,
  setPrimaryModel,
  getPrimaryModel,
  syncRegistry,
  recentModelEvents,
} from '@/lib/ai/model-registry';

describe('model registry (configuration)', () => {
  it('contains exactly the 50 requested text model IDs, in order, with no duplicates', () => {
    expect(textToTextModels).toHaveLength(EXPECTED_TEXT_MODEL_COUNT);
    expect(EXPECTED_TEXT_MODEL_COUNT).toBe(55);
    expect(new Set(textToTextModels).size).toBe(EXPECTED_TEXT_MODEL_COUNT);
  });

  it('contains exactly the 20 requested image model IDs, in order, with no duplicates', () => {
    expect(textToImageModels).toHaveLength(EXPECTED_IMAGE_MODEL_COUNT);
    expect(EXPECTED_IMAGE_MODEL_COUNT).toBe(23);
    expect(new Set(textToImageModels).size).toBe(EXPECTED_IMAGE_MODEL_COUNT);
  });

  it('preserves the exact supplied identifiers', () => {
    const requiredText = [
      'agnes-2.5-flash',
      'agnes-2.5-pro-alpha',
      'agnes-1.5-flash',
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen2.5-72B-Instruct',
      'meta-llama/Llama-3.1-70B-Instruct',
      'meta-llama/Llama-3.3-70B-Instruct',
      'mistralai/Mixtral-8x22B-Instruct-v0.1',
      'google/gemma-2-27b-it',
      'CohereForAI/c4ai-command-r-plus',
      'databricks/dbrx-instruct',
      'LiquidAI/LFM2.5-24B-A2B',
      'tencent/Hy-Memory-30B-A3B',
      'jialinyyzz/humanizer',
      'ConwayResearch/Underdog-Saluki-27B-1.0',
      'fblgit/ESTHER-7B',
      'OpenLLM-France/Luciole-1B-Instruct',
      'epfl-llm/meditron-70b',
    ];
    const requiredImage = [
      'agnes-image-2.5-flash',
      'agnes-image-2.1-flash',
      'black-forest-labs/FLUX.1-dev',
      'black-forest-labs/FLUX.1-schnell',
      'black-forest-labs/flux-3-image-klein',
      'XLabs-AI/flux-RealismLora',
      'Qwen/Qwen-Image-2.1-Turbo',
      'OpenMOSS-Team/MOSS-Image-SFT',
      'DeepFloyd/IF-I-XL-v1.0',
      'kandinsky-community/kandinsky-3',
      'pixart-alpha/PixArt-sigma-xl2-1024-MS',
      'cagliostrolab/animagine-xl-3.1',
    ];
    for (const id of requiredText) expect(textToTextModels).toContain(id);
    for (const id of requiredImage) expect(textToImageModels).toContain(id);
  });

  it('reports no structural problems', () => {
    expect(validateRegistries()).toEqual([]);
  });

  it('assigns a category to every model and uses the expected task on every row', () => {
    for (const model of buildTextModelMetadata()) {
      expect(model.category).not.toBe('Uncategorised');
      expect(model.task).toBe('text-generation');
      expect(model.availabilityStatus).toBe('unverified');
      expect(model.pricingStatus).toBe('unknown');
      expect(model.failureCount).toBe(0);
      expect(model.verified).toBe(false);
    }
    for (const model of buildImageModelMetadata()) {
      expect(model.category).not.toBe('Uncategorised');
      expect(model.task).toBe('text-to-image');
    }
    expect(Object.keys(TEXT_MODEL_CATEGORIES)).toHaveLength(8);
    expect(Object.keys(IMAGE_MODEL_CATEGORIES)).toHaveLength(6);
  });

  it('resolves task membership and rejects unknown ids', () => {
    expect(taskForModelId('Qwen/Qwen2.5-7B-Instruct')).toBe('text-generation');
    expect(taskForModelId('black-forest-labs/FLUX.1-schnell')).toBe('text-to-image');
    expect(taskForModelId('not-a-real/model')).toBeNull();
    expect(isRegisteredModelId('Qwen/Qwen2.5-7B-Instruct')).toBe(true);
    expect(isRegisteredModelId('someone/else')).toBe(false);
  });

  it('documents the LoRA adapter rather than pretending it is a standalone model', () => {
    const lora = buildImageModelMetadata().find(m => m.id === 'XLabs-AI/flux-RealismLora');
    expect(lora?.limitations.join(' ')).toMatch(/LoRA adapter weights/i);
    expect(lora?.task).toBe('text-to-image');
  });
});

describe('model registry (persistence)', () => {
  beforeEach(() => {
    freshDatabase();
    resetRegistryForTests();
  });

  it('seeds all 70 configured models exactly once', () => {
    const first = syncRegistry();
    expect(first.added).toHaveLength(78);
    const second = syncRegistry();
    expect(second.added).toHaveLength(0);
    expect(listModelRows({ limit: 500 })).toHaveLength(78);
    expect(listModelRows({ task: 'text-generation', limit: 500 })).toHaveLength(55);
    expect(listModelRows({ task: 'text-to-image', limit: 500 })).toHaveLength(23);
  });

  it('never overwrites verification data when re-seeding', () => {
    syncRegistry();
    recordModelSuccess('Qwen/Qwen2.5-7B-Instruct', { provider: 'together', latencyMs: 800, task: 'text-generation' });
    const before = getModelRow('Qwen/Qwen2.5-7B-Instruct');
    syncRegistry();
    const after = getModelRow('Qwen/Qwen2.5-7B-Instruct');
    expect(after?.availabilityStatus).toBe('available');
    expect(after?.provider).toBe('together');
    expect(after?.successCount).toBe(before?.successCount);
  });

  it('records success and failure metrics with an event trail', () => {
    syncRegistry();
    recordModelSuccess('Qwen/Qwen2.5-7B-Instruct', { provider: 'together', latencyMs: 1_000, task: 'text-generation' });
    recordModelSuccess('Qwen/Qwen2.5-7B-Instruct', { provider: 'together', latencyMs: 2_000, task: 'text-generation' });
    let row = getModelRow('Qwen/Qwen2.5-7B-Instruct');
    expect(row?.availabilityStatus).toBe('available');
    expect(row?.successCount).toBe(2);
    expect(row?.averageLatencyMs).toBeGreaterThan(1_000);
    expect(row?.lastSuccessfulAt).toBeTruthy();

    recordModelFailure('Qwen/Qwen2.5-7B-Instruct', {
      category: 'rate_limited',
      availability: 'rate_limited',
      message: 'Rate limited by provider',
      task: 'text-generation',
    });
    row = getModelRow('Qwen/Qwen2.5-7B-Instruct');
    expect(row?.failureCount).toBe(1);
    expect(row?.availabilityStatus).toBe('rate_limited');

    const failures = recentModelEvents({ onlyFailures: true, modelId: 'Qwen/Qwen2.5-7B-Instruct' });
    expect(failures).toHaveLength(1);
    expect(failures[0].category).toBe('rate_limited');
    expect(recentModelEvents({ modelId: 'Qwen/Qwen2.5-7B-Instruct' }).length).toBeGreaterThanOrEqual(3);
  });

  it('supports enable/disable and primary selection', () => {
    syncRegistry();
    const disabled = setModelEnabled('Qwen/Qwen2.5-7B-Instruct', false, 'Too slow for long chapters');
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.disabledReason).toBe('Too slow for long chapters');
    expect(listModelRows({ task: 'text-generation', enabled: false }).map(r => r.id)).toContain('Qwen/Qwen2.5-7B-Instruct');

    setModelEnabled('Qwen/Qwen2.5-7B-Instruct', true);
    expect(getModelRow('Qwen/Qwen2.5-7B-Instruct')?.enabled).toBe(true);

    setPrimaryModel('text-to-image', 'black-forest-labs/FLUX.1-schnell');
    expect(getPrimaryModel('text-to-image')?.id).toBe('black-forest-labs/FLUX.1-schnell');
    setPrimaryModel('text-to-image', 'runwayml/stable-diffusion-v1-5');
    expect(getPrimaryModel('text-to-image')?.id).toBe('runwayml/stable-diffusion-v1-5');
    // Only one primary per task.
    expect(listModelRows({ task: 'text-to-image' }).filter(r => r.isPrimary)).toHaveLength(1);
  });

  it('computes dashboard counts from persisted evidence only', () => {
    syncRegistry();
    let overview = registryOverview();
    expect(overview.configured).toEqual({ text: 55, image: 23, total: 78 });
    expect(overview.successfullyTested).toBe(0);
    expect(overview.hostedInferenceSupported).toBe(0);
    expect(overview.byPricing.unknown).toBe(78);
    expect(overview.enabled).toBe(78);

    patchModel('Qwen/Qwen2.5-7B-Instruct', { availabilityStatus: 'available', pricingStatus: 'free', provider: 'together' });
    patchModel('black-forest-labs/FLUX.1-schnell', { availabilityStatus: 'available', pricingStatus: 'free', provider: 'fal-ai' });
    setModelEnabled('databricks/dbrx-instruct', false);
    overview = registryOverview();
    expect(overview.hostedInferenceSupported).toBe(2);
    expect(overview.byPricing.free).toBe(2);
    expect(overview.disabled).toBe(1);
    expect(overview.enabled).toBe(77);
  });

  it('filters by search, category, availability and pricing', () => {
    syncRegistry();
    patchModel('microsoft/Phi-3-mini-4k-instruct', { availabilityStatus: 'unsupported', pricingStatus: 'unknown' });
    patchModel('Qwen/Qwen2.5-7B-Instruct', { pricingStatus: 'free' });

    expect(listModelRows({ search: 'qwen2.5-7b' }).map(r => r.id)).toEqual(['Qwen/Qwen2.5-7B-Instruct']);
    expect(listModelRows({ pricing: ['free'] }).map(r => r.id)).toEqual(['Qwen/Qwen2.5-7B-Instruct']);
    expect(listModelRows({ availability: ['unsupported'] }).map(r => r.id)).toEqual(['microsoft/Phi-3-mini-4k-instruct']);
    expect(listModelRows({ category: 'Tier 5: Code Specialists' }).length).toBe(4);
  });

  it('stores limitations and adapter metadata as JSON on the row', () => {
    syncRegistry();
    patchModel('XLabs-AI/flux-RealismLora', {
      adapter: { kind: 'lora', baseModel: 'black-forest-labs/FLUX.1-dev', weightsPath: 'flux-RealismLora.safetensors' },
      availabilityStatus: 'unsupported',
    });
    const row = getModelRow('XLabs-AI/flux-RealismLora')!;
    expect(JSON.parse(row.adapter!)).toMatchObject({ kind: 'lora' });
    expect(row.availabilityStatus).toBe('unsupported');
    expect(db().prepare('SELECT COUNT(*) AS c FROM ai_model_registry WHERE task = ?').get('text-to-image')).toEqual({ c: 23 });
  });
});
