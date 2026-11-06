import 'server-only';
import {
  isGenerationType,
  type GenerationHandler,
  type GenerationType,
} from './generation-types';

/**
 * Registry for generation handlers.
 *
 * NovelForge's built-in generation types are executed by
 * `UniversalGenerationService` itself (text, structured and image paths), so a
 * type does **not** need a registered handler to be generatable. A handler is
 * only needed when a feature wants to replace the generic behaviour for one
 * type (for example a bespoke pipeline owned by another module).
 *
 * Because of that, "is this job owned by the universal engine?" must never be
 * answered with `hasHandler()`. Job ownership comes from the persisted job
 * payload marker (`payload.engine === 'universal'`, see
 * `generation-persistence.ts` / `isUniversalEngineJob`).
 */
export const GenerationRegistry = {
  handlers: new Map<GenerationType, GenerationHandler>(),

  /** Registers (or replaces) the handler for one generation type. */
  register(type: GenerationType, handler: GenerationHandler): void {
    if (typeof type !== 'string' || !isGenerationType(type)) {
      throw new Error(`Cannot register a handler for unknown generation type: ${String(type)}`);
    }
    if (typeof handler !== 'function') {
      throw new Error(`Handler for generation type ${type} must be a function.`);
    }
    if (this.handlers.has(type)) {
      console.warn(`[generation-registry] Overwriting handler for ${type}`);
    }
    this.handlers.set(type, handler);
  },

  /** Removes a handler (test seam / feature rollback). */
  unregister(type: GenerationType): boolean {
    return this.handlers.delete(type);
  },

  getHandler(type: GenerationType): GenerationHandler | undefined {
    return this.handlers.get(type);
  },

  hasHandler(type: GenerationType): boolean {
    return this.handlers.has(type);
  },

  /**
   * Backwards-compatible alias for `hasHandler`.
   *
   * Kept because several modules read better as `GenerationRegistry.has(type)`;
   * it answers only "is a custom handler registered", never "can this type be
   * generated".
   */
  has(type: GenerationType): boolean {
    return this.handlers.has(type);
  },

  listTypes(): GenerationType[] {
    return Array.from(this.handlers.keys());
  },

  /** Clears every handler (tests only). */
  clear(): void {
    this.handlers.clear();
  },
};

/** Convenience guard used by routes that accept an optional custom handler. */
export function hasCustomGenerationHandler(type: unknown): boolean {
  return isGenerationType(type) && GenerationRegistry.hasHandler(type);
}
