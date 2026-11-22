import { Cpu } from 'lucide-react';
import { displayNameFor } from '@/lib/ai/models';
import { isPlaceholderProvider, type ModelUsage } from '@/lib/ai/model-provenance';
import { cn } from '@/lib/utils/cn';

interface ModelIndicatorProps {
  requestedModel?: string | null;
  actualModel?: string | null;
  provider?: string | null;
  fallbackUsed?: boolean | null;
  /** Some jobs (such as consistency checks) make multiple independent calls. */
  modelUsages?: ModelUsage[] | null;
  status?: string | null;
  className?: string;
}

function providerName(provider?: string | null): string | null {
  if (!provider || provider === 'auto') return null;
  const known: Record<string, string> = {
    agnes: 'Agnes AI',
    'agnes-ai': 'Agnes AI',
    huggingface: 'Hugging Face',
    'hf-inference': 'Hugging Face',
    openai: 'OpenAI',
    together: 'Together AI',
  };
  return known[provider.toLowerCase()] || provider;
}

function usableModel(model?: string | null): model is string {
  return !!model && !['auto', 'unknown'].includes(model.toLowerCase());
}

function modelName(model: string): string {
  // Keep repository owners and case-sensitive provider IDs visible; two repos
  // can share the same short name. Agnes's display name is unambiguous.
  return /^agnes([-.]|$)/i.test(model) ? displayNameFor(model) : model;
}

/**
 * Show the request while a job is pending and the *actual* model on its result.
 * Automatic selection and fallbacks can change during a request, so a requested
 * model is never presented as a confirmed model. Old records stay unknown.
 */
export function ModelIndicator({
  requestedModel,
  actualModel,
  provider,
  fallbackUsed,
  modelUsages,
  status,
  className,
}: ModelIndicatorProps) {
  const normalizedStatus = (status || '').toLowerCase();
  const active = ['idle', 'pending', 'queued', 'processing'].includes(normalizedStatus);
  const noResult = ['failed', 'cancelled'].includes(normalizedStatus);
  const entries: ModelUsage[] = modelUsages?.length
    ? modelUsages
    : [{ actualModel: actualModel ?? null, provider: provider ?? null, fallbackUsed: !!fallbackUsed }];

  if (modelUsages && modelUsages.length === 0 && !active && !noResult) {
    return <div className={cn('text-xs text-muted-foreground', className)}>No AI model was used.</div>;
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground', className)}>
      {entries.map((entry, index) => {
        const currentProvider = entry.provider?.toLowerCase();
        let label: string;
        let title: string | undefined;
        if (isPlaceholderProvider(currentProvider)) {
          const demo = currentProvider === 'demo' || currentProvider === 'demo-svg';
          label = noResult ? 'No usable AI output' : demo ? 'Demo output · no AI model' : 'Placeholder output · no AI model';
        } else if (usableModel(entry.actualModel)) {
          const wasFallback = entry.fallbackUsed;
          const via = providerName(entry.provider);
          const prefix = noResult ? 'Last model' : active ? 'Model used so far' : 'Model used';
          label = `${prefix}: ${modelName(entry.actualModel)}${via ? ` · ${via}` : ''}${wasFallback ? ' (fallback)' : ''}`;
          title = `Model ID: ${entry.actualModel}${requestedModel && requestedModel !== 'auto' ? ` · Requested: ${requestedModel}` : ''}`;
        } else if (active || noResult) {
          const requested = usableModel(requestedModel) ? modelName(requestedModel) : 'Automatic';
          label = `Requested model: ${requested}${active ? ' · actual model shown when ready' : ''}`;
          title = usableModel(requestedModel) ? `Requested model ID: ${requestedModel}` : undefined;
        } else {
          label = 'Model used: Not recorded';
        }
        return (
          <span key={`${entry.actualModel ?? ''}:${entry.provider ?? ''}:${index}`} className="inline-flex items-start gap-1.5 min-w-0" title={title}>
            <Cpu className="w-3.5 h-3.5 shrink-0 mt-0.5 text-primary/80" aria-hidden="true" />
            <span className="break-words">{label}</span>
          </span>
        );
      })}
    </div>
  );
}
