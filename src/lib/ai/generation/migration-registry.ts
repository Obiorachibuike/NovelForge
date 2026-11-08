/**
 * UNIVERSAL GENERATION REGISTRY INTEGRATION
 *
 * Adapts the existing NovelForge domain services (chapters, outlines, premise,
 * humanization) to the `GenerationRegistry` contract used by
 * `UniversalGenerationService.executeJob`.
 *
 * STATUS: this module is intentionally **not imported anywhere yet**, so none of
 * these handlers are registered at runtime and every job still runs through the
 * queue's own handler registry (`registerHandler` in each service). Importing it
 * from the worker entry point reroutes those task types through the universal
 * engine; that switch needs its own execution, cancellation, retry and provider
 * tests before it is enabled (see docs/audit-2026-11-01.md §2).
 *
 * Handlers receive the durable job id and parsed payload through
 * `GenerationExecutionContext`, so they pass the real `jobId` to the services —
 * never the novel id — which is what keeps crash-resumption and provenance
 * working (`chapters.lastJobId`).
 */

import 'server-only';
import { GenerationRegistry } from '@/lib/ai/generation/generation-registry';
import {
  payloadBoolean,
  payloadNumber,
  payloadString,
  type GenerationRequest,
  type GenerationResult,
} from '@/lib/ai/generation/generation-types';
import type { HumanizationMode } from '@/services/humanization/service';

import { runChapterGeneration } from '@/services/chapters/service';
import { runOutline } from '@/services/outlines/service';
import { runPremise } from '@/services/preparation/service';

// 1. Chapter generation
GenerationRegistry.register('chapter', async (request: GenerationRequest, context) => {
  const payload = context.payload;

  return await runChapterGeneration({
    id: context.jobId,
    novelId: request.projectId,
    userId: request.userId,
    chapterId: request.targetId ?? null,
    payload: {
      chapterNumber: payloadNumber(payload, 'chapterNumber') ?? 1,
      confirmOverwrite: payloadBoolean(payload, 'confirmOverwrite') ?? false,
      textModel:
        payloadString(payload, 'textModel') ??
        payloadString(payload, 'model') ??
        request.model,
      allowFallback: payloadBoolean(payload, 'allowFallback') !== false,
    },
    setStage: context.setStage,
    isCancelled: context.isCancelled,
    signal: context.signal,
  });
});

// 2. Outline generation
GenerationRegistry.register('outline', async (request: GenerationRequest, context) => {
  const payload = context.payload;

  return await runOutline({
    id: context.jobId,
    novelId: request.projectId,
    userId: request.userId,
    payload: {
      structureType: payloadString(payload, 'structureType') ?? 'three-act',
      textModel: payloadString(payload, 'textModel') ?? request.model,
      allowFallback: payloadBoolean(payload, 'allowFallback') !== false,
    },
  });
});

// 3. Premise generation
GenerationRegistry.register('premise', async (request: GenerationRequest, context) => {
  const payload = context.payload;

  return await runPremise({
    id: context.jobId,
    novelId: request.projectId,
    userId: request.userId,
    payload: {
      textModel: payloadString(payload, 'textModel') ?? request.model,
      allowFallback: payloadBoolean(payload, 'allowFallback') !== false,
    },
  });
});

// 4. Humanization (synchronous request/response; no durable domain row)
GenerationRegistry.register('humanize', async (request: GenerationRequest, context) => {
  // Imported lazily: the humanization service pulls in the provider clients and
  // is only needed when this handler actually runs.
  const { humanizePassage } = await import('@/services/humanization/service');

  context.setStage('PROCESSING_HUMANIZE');

  const requestedMode = payloadString(request.context, 'mode');
  const mode: HumanizationMode =
    requestedMode === 'light' || requestedMode === 'deep' ? requestedMode : 'natural';

  const rewritten = await humanizePassage({
    text: request.prompt,
    modelId: request.model,
    mode,
    instructions: payloadString(request.context, 'instructions') ?? '',
    context: payloadString(request.context, 'context') ?? '',
  });

  const result: GenerationResult = {
    text: rewritten.revised,
    meta: {
      source: rewritten.provider?.includes('agnes') ? 'agnes' : 'huggingface',
      model: rewritten.modelId,
      actualModel: rewritten.modelId,
      provider: rewritten.provider,
      usedFallback: false,
      attempts: 1,
      latencyMs: rewritten.latencyMs ?? 0,
      usage: rewritten.usage,
    },
  };

  return result;
});
