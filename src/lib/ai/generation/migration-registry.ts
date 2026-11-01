/**
 * UNIVERSAL GENERATION REGISTRY INTEGRATION
 *
 * Registers existing NovelForge services into the UniversalGenerationService.
 */

import { GenerationRegistry } from '@/lib/ai/generation/generation-registry';
import { GenerationRequest } from '@/lib/ai/generation/generation-types';
import { UniversalGenerationService } from '@/lib/ai/generation/generation-service';
import { registerHandler } from '@/lib/queue';

// Import services
import { runChapterGeneration, enqueueChapterGeneration } from '@/services/chapters/service';
import { runOutline, enqueueOutline } from '@/services/outlines/service';
import { runPremise, enqueuePrepareNovel } from '@/services/preparation/service';

// 1. Chapter Generation Handler
GenerationRegistry.register('chapter', async (request: GenerationRequest) => {
  const { projectId, userId, targetId, payload, context, signal, setStage, isCancelled } = request;
  
  // Adapt UniversalRequest to existing service signature
  const servicePayload = {
    chapterNumber: payload?.chapterNumber || 1,
    confirmOverwrite: payload?.confirmOverwrite || false,
    textModel: payload?.model || undefined,
    allowFallback: payload?.allowFallback !== false,
  };

  // Note: runChapterGeneration expects specific context. We map UniversalGenerationService context.
  const handlerContext = {
    id: request.projectId, // placeholder, actual jobId passed in payload or context
    payload: servicePayload,
    novelId: projectId,
    userId,
    chapterId: targetId,
    setStage: context.setStage,
    setProgress: context.setProgress,
    isCancelled,
    signal,
  };

  // In real integration, we would call runChapterGeneration directly with the context.
  // The existing runChapterGeneration takes { id, novelId, userId, payload, setStage, isCancelled, signal }
  // We adapt the UniversalGenerationService context to match.
  
  // Note: We need to pass the actual jobId from the universal engine into the service handler.
  // The UniversalGenerationService.executeJob will call this handler.
  
  // For now, we register the handler to route to the existing service logic.
  // The actual implementation of runChapterGeneration already handles streaming via `onText`.
  
  // We'll wrap the existing runChapterGeneration to match UniversalGenerationService's signature.
  return await runChapterGeneration({
    id: request.projectId, // We'll pass the actual jobId in executeJob context
    novelId: projectId,
    userId,
    payload: servicePayload,
    setStage: context.setStage,
    isCancelled,
    signal,
  } as any); // Cast to match existing service signature
});

// 2. Outline Generation Handler
GenerationRegistry.register('outline', async (request: GenerationRequest) => {
  const { projectId, userId, payload, context, signal, setStage, isCancelled } = request;
  
  const servicePayload = {
    structureType: payload?.structureType || 'three-act',
    textModel: payload?.model || undefined,
    allowFallback: payload?.allowFallback !== false,
  };

  // Adapt UniversalRequest to existing service signature
  // Note: runOutline takes { id, novelId, userId, payload }
  return await runOutline({
    id: request.projectId, // placeholder
    novelId: projectId,
    userId,
    payload: servicePayload,
  } as any);
});

// 3. Premise Generation Handler
GenerationRegistry.register('premise', async (request: GenerationRequest) => {
  const { projectId, userId, payload, context, signal, setStage, isCancelled } = request;
  
  const servicePayload = {
    textModel: payload?.model || undefined,
    allowFallback: payload?.allowFallback !== false,
  };

  return await runPremise({
    id: request.projectId,
    novelId: projectId,
    userId,
    payload: servicePayload,
  } as any);
});

// 4. Humanize Handler (Migration)
GenerationRegistry.register('humanize', async (request: GenerationRequest) => {
  const { prompt, context, userId, projectId, targetId, model, signal, isCancelled, setStage } = request;
  const { humanizePassage } = await import('@/services/humanization/service');
  
  setStage('PROCESSING_HUMANIZE');
  
  const result = await humanizePassage({
    text: prompt,
    modelId: model,
    mode: context?.mode || 'natural',
    instructions: context?.instructions || '',
    context: context?.context || '',
  });

  // Persist result via UniversalGenerationService logic (handled in executeJob)
  // We return the result structure
  return {
    text: result.revised,
    meta: {
      source: result.provider?.includes('agnes') ? 'agnes' : 'huggingface',
      model: result.modelId,
      actualModel: result.modelId,
      provider: result.provider,
      usedFallback: false,
      attempts: 1,
      latencyMs: result.latencyMs,
      usage: result.usage,
    },
  };
});

// Register existing chapter handler in queue.ts as well (for backward compatibility during transition)
// We'll keep the existing queue/worker logic but route everything through UniversalGenerationService.

// Update existing queue/index.ts runJob to call UniversalGenerationService.executeJob
// This will be done in the next step (modifying src/lib/queue/index.ts)
