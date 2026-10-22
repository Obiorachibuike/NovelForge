'use client';
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export interface SelectorModel {
  id: string;
  name: string;
  category: string;
  availabilityStatus: string;
  pricingStatus: string;
  enabled: boolean;
  provider?: string | null;
  averageLatencyMs?: number | null;
  lastSuccessfulAt?: string | null;
  isPrimary?: boolean;
  limitations?: string | null;
}

interface Props {
  task: 'text-generation' | 'text-to-image';
  value: string;
  allowFallback: boolean;
  onChange: (value: string) => void;
  onAllowFallbackChange: (value: boolean) => void;
  disabled?: boolean;
  compact?: boolean;
}

const AVAILABILITY_STYLE: Record<string, { className: string; icon: any; label: string }> = {
  available: { className: 'text-emerald-400', icon: CheckCircle2, label: 'Available' },
  unverified: { className: 'text-muted-foreground', icon: HelpCircle, label: 'Unverified' },
  unknown: { className: 'text-muted-foreground', icon: HelpCircle, label: 'Unknown' },
  paid_only: { className: 'text-amber-400', icon: AlertTriangle, label: 'Paid only' },
  authentication_required: { className: 'text-amber-400', icon: AlertTriangle, label: 'Access required' },
  unsupported: { className: 'text-destructive', icon: AlertTriangle, label: 'Unsupported' },
  unavailable: { className: 'text-destructive', icon: AlertTriangle, label: 'Unavailable' },
  rate_limited: { className: 'text-amber-400', icon: AlertTriangle, label: 'Rate limited' },
  temporarily_unavailable: { className: 'text-amber-400', icon: AlertTriangle, label: 'Temporarily down' },
};

const PRICING_LABEL: Record<string, string> = {
  free: 'Free',
  paid: 'Paid',
  unknown: 'Unknown pricing',
};

/**
 * User-facing model selection.
 *
 * Shows only what the registry knows: an unverified model is labelled
 * "Unverified", never presented as ready to use. Models disabled or ineligible
 * under the current pricing policy are shown but marked, so the choice is
 * honest rather than hidden.
 */
export default function ModelSelector({
  task, value, allowFallback, onChange, onAllowFallbackChange, disabled, compact,
}: Props) {
  const [models, setModels] = useState<SelectorModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`/api/ai/models/${task === 'text-generation' ? 'text' : 'image'}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load models');
        return r.json();
      })
      .then(data => {
        if (!cancelled) setModels(data.models ?? []);
      })
      .catch(err => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [task]);

  const ordered = useMemo(() => {
    if (!models) return [];
    return [...models].sort((a, b) => {
      const rank = (m: SelectorModel) =>
        (m.availabilityStatus === 'available' ? 0 : m.availabilityStatus === 'unverified' ? 1 : 2) + (m.enabled ? 0 : 3);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.name.localeCompare(b.name);
    });
  }, [models]);

  const selected = models?.find(m => m.id === value);

  if (error) {
    return <p className="text-xs text-destructive">{error}</p>;
  }
  if (!models) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading models…
      </div>
    );
  }
  if (!models.length) {
    return <p className="text-xs text-muted-foreground">No {task === 'text-generation' ? 'text' : 'image'} models registered.</p>;
  }

  return (
    <div className={cn('space-y-2', compact && 'space-y-1.5')}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="label" htmlFor={`model-${task}`}>
          {task === 'text-generation' ? 'Text model' : 'Image model'}
        </label>
        <select
          id={`model-${task}`}
          className="input max-w-[22rem]"
          value={value}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
        >
          <option value="auto">Automatic — pick the best eligible model</option>
          {ordered.map(m => (
            <option key={m.id} value={m.id} disabled={!m.enabled}>
              {m.name}
              {m.availabilityStatus === 'available' ? '' : ` (${AVAILABILITY_STYLE[m.availabilityStatus]?.label ?? m.availabilityStatus})`}
              {m.enabled ? '' : ' · disabled'}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            className="accent-primary"
            checked={allowFallback}
            disabled={disabled}
            onChange={e => onAllowFallbackChange(e.target.checked)}
          />
          Allow automatic fallback
        </label>
      </div>

      <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
        {selected ? (
          <>
            {(() => {
              const style = AVAILABILITY_STYLE[selected.availabilityStatus] ?? AVAILABILITY_STYLE.unknown;
              const Icon = style.icon;
              return (
                <span className={cn('inline-flex items-center gap-1', style.className)}>
                  <Icon className="w-3 h-3" /> {style.label}
                </span>
              );
            })()}
            <span
              className={cn(
                'chip',
                selected.pricingStatus === 'free' && 'chip-success',
                selected.pricingStatus === 'paid' && 'chip-warning',
                selected.pricingStatus === 'unknown' && 'chip-muted',
              )}
            >
              {PRICING_LABEL[selected.pricingStatus] ?? selected.pricingStatus}
            </span>
            <span className="truncate">{selected.category}</span>
            {selected.provider && <span>via {selected.provider}</span>}
            {selected.averageLatencyMs ? <span>~{(selected.averageLatencyMs / 1000).toFixed(1)}s</span> : null}
            {selected.isPrimary && (
              <span className="inline-flex items-center gap-1 text-primary">
                <Sparkles className="w-3 h-3" /> primary
              </span>
            )}
          </>
        ) : (
          <span>Automatic selection chooses an eligible model that satisfies the current availability and pricing policy.</span>
        )}
      </div>
    </div>
  );
}
