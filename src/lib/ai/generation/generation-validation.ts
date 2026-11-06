import 'server-only';
import { z } from 'zod';
import { GenerationRequestSchema, type GenerationRequest } from './generation-types';

/**
 * Validates and normalises a generation request.
 *
 * The schema is the single source of truth for both creation (`POST
 * /api/generations/universal`) and worker execution, so a request that passed
 * HTTP validation can never be rejected later for a different reason, and a
 * persisted legacy payload is upgraded to the same shape.
 */
export function validateGenerationRequest(input: unknown): GenerationRequest {
  const parsed = GenerationRequestSchema.parse(input);
  return {
    projectId: parsed.projectId,
    userId: parsed.userId,
    generationType: parsed.generationType,
    ...(parsed.customType ? { customType: parsed.customType } : {}),
    ...(parsed.targetType ? { targetType: parsed.targetType } : {}),
    ...(parsed.targetId ? { targetId: parsed.targetId } : {}),
    prompt: parsed.prompt,
    context: parsed.context ?? {},
    ...(parsed.provider ? { provider: parsed.provider } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    stream: parsed.stream === true,
    metadata: parsed.metadata ?? {},
    ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
  };
}

/**
 * Validates a *public* generation request.
 *
 * Public input never carries the owner: whatever `userId` the body claims is
 * discarded and replaced with the authenticated identity, so a caller can never
 * create work (or spend credits) in another account.
 */
export function validateGenerationInput(input: unknown, userId: string): GenerationRequest {
  const body = z.record(z.unknown()).parse(input);
  return validateGenerationRequest({ ...body, userId });
}

/** Validates a persisted job's stored request without re-parsing HTTP input. */
export function validateGenerationRequestOrThrow(input: unknown): GenerationRequest {
  return validateGenerationRequest(input);
}

/**
 * Validates chunk persistence parameters.
 */
export const ChunkPersistenceSchema = z.object({
  jobId: z.string().min(1),
  sequence: z.number().int().min(0),
  content: z.string(),
  isComplete: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function validateChunkPersistence(input: unknown) {
  return ChunkPersistenceSchema.parse(input);
}
