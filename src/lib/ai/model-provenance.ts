/** Client-safe model provenance shared by generation views and job responses. */
export interface ModelUsage {
  actualModel: string | null;
  provider: string | null;
  /** True when the provider used a different model or provider after a failure. */
  fallbackUsed?: boolean;
}

/** Consistency checks can use a different model for each chapter. */
export function modelUsagesFromResult(result: unknown): ModelUsage[] | undefined {
  if (!result || typeof result !== 'object' || !Array.isArray((result as { modelUsages?: unknown }).modelUsages)) {
    return undefined;
  }
  return (result as { modelUsages: unknown[] }).modelUsages.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const usage = value as Partial<ModelUsage>;
    return [{
      actualModel: typeof usage.actualModel === 'string' ? usage.actualModel : null,
      provider: typeof usage.provider === 'string' ? usage.provider : null,
      fallbackUsed: usage.fallbackUsed === true,
    }];
  });
}

/** An output labelled demo or fallback is not a response from an AI model. */
export function isPlaceholderProvider(provider?: string | null): boolean {
  return ['demo', 'demo-svg', 'fallback', 'svg-fallback'].includes((provider || '').toLowerCase());
}
