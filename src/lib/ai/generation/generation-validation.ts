import 'server-only';
import { z } from 'zod';
import { GenerationRequestSchema, type GenerationRequest } from './generation-types';

/**
 * Validates generation requests.
 * Extends the base schema with feature-specific constraints.
 */
export function validateGenerationRequest(input: unknown): GenerationRequest {
  const parsed = GenerationRequestSchema.parse(input);
  // strictNullChecks is disabled in this project, so Zod's inferred object type
  // marks required keys as optional. Validate required fields explicitly rather
  // than asserting the whole object into the domain type.
  return {
    ...parsed,
    projectId: GenerationRequestSchema.shape.projectId.parse(parsed.projectId),
    userId: GenerationRequestSchema.shape.userId.parse(parsed.userId),
    generationType: GenerationRequestSchema.shape.generationType.parse(parsed.generationType),
    prompt: GenerationRequestSchema.shape.prompt.parse(parsed.prompt),
  };
}

/**
 * Validates chunk persistence parameters.
 */
export const ChunkPersistenceSchema = z.object({
  jobId: z.string(),
  sequence: z.number(),
  content: z.string(),
  isComplete: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function validateChunkPersistence(input: unknown) {
  return ChunkPersistenceSchema.parse(input);
}

/** Parse public input using the authenticated identity, never a client-supplied userId. */
export function validateGenerationInput(input: unknown, userId: string): GenerationRequest {
  const body = z.record(z.unknown()).parse(input);
  return validateGenerationRequest({ ...body, userId });
}
