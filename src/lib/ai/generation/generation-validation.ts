import 'server-only';
import { z } from 'zod';
import { GenerationRequestSchema } from './generation-types';

/**
 * Validates generation requests.
 * Extends the base schema with feature-specific constraints.
 */
export function validateGenerationRequest(input: unknown): GenerationRequest {
  const parsed = GenerationRequestSchema.parse(input);
  return parsed;
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
