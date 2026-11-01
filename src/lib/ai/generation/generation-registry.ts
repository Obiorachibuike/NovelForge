import 'server-only';
import { GenerationRequest, GenerationType } from './generation-types';

/**
 * Registry for generation types.
 * Allows new features to register handlers without modifying the core engine.
 */
export const GenerationRegistry = {
  handlers: new Map<GenerationType, (request: GenerationRequest) => Promise<unknown>>(),

  register(type: GenerationType, handler: (request: GenerationRequest) => Promise<unknown>) {
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
