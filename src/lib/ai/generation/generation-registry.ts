import 'server-only';
import type { GenerationHandler, GenerationType } from './generation-types';

/**
 * Registry for generation types.
 * Allows new features to register handlers without modifying the core engine.
 *
 * A handler receives the validated `GenerationRequest` plus the queue's
 * `GenerationExecutionContext` (durable job id, parsed payload, cancellation),
 * so it can persist progress against the real job row.
 */
export const GenerationRegistry = {
  handlers: new Map<GenerationType, GenerationHandler>(),

  register(type: GenerationType, handler: GenerationHandler) {
    if (this.handlers.has(type)) {
      console.warn(`[generation-registry] Overwriting handler for ${type}`);
    }
    this.handlers.set(type, handler);
  },

  getHandler(type: GenerationType) {
    return this.handlers.get(type);
  },

  hasHandler(type: GenerationType) {
    return this.handlers.has(type);
  },

  listTypes() {
    return Array.from(this.handlers.keys());
  },
};

// Pre-register core types that we will migrate
// (actual registration will happen in each service file to avoid circular imports)
