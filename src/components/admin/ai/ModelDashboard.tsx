'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Activity, AlertTriangle, CheckCircle2, CircleDollarSign, Clock, Cpu, Eye, HelpCircle,
  Image as ImageIcon, Loader2, RefreshCw, Search, ShieldAlert, Sparkles, Star, Type, XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface RegistryModel {
  id: string;
  name: string;
  task: 'text-generation' | 'text-to-image';
  category: string;
  provider: string | null;
  availabilityStatus: string;
  pricingStatus: string;
  license: string | null;
  enabled: boolean;
  verified: boolean;
  contextLength: number | null;
  supportedSizes: string | null;
  supportsNegativePrompt: boolean | null;
  limitations: string | null;
  adapter: string | null;
  verificationSource: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessfulAt: string | null;
  averageLatencyMs: number | null;
  failureCount: number;
  successCount: number;
  isPrimary: boolean;
  disabledReason: string | null;
}

interface Overview {
  configured: { text: number; image: number; total: number };
  registered: { text: number; image: number; total: number };
  byAvailability: Record<string, number>;
  byPricing: Record<string, number>;
  verifiedRepositories: number;
  hostedInferenceSupported: number;
  successfullyTested: number;
  unavailable: number;
  unsupported: number;
  authenticationRequired: number;
  enabled: number;
  disabled: number;
  primary: { text: string | null; image: string | null };
  recentFailures: number;
  recentSuccesses: number;
}

interface EventRow {
  id: string;
  modelId: string;
  kind: string;
  ok: boolean;
  category: string | null;
  provider: string | null;
  latencyMs: number | null;
  message: string | null;
  createdAt: string;
}

interface Configuration {
  backend: string;
  huggingFaceConfigured: boolean;
  allowPaidInference: boolean;
  requireConfirmedPricing: boolean;
  fallbackEnabled: boolean;
  maxFallbackAttempts: number;
  requestTimeoutMs: number;
  healthCheckIntervalHours: number;
  maxTextRequestsPerUserPerHour: number;
  maxImageRequestsPerUserPerHour: number;
  routerBaseUrl: string;
}

type Tab = 'overview' | 'text' | 'image' | 'monitoring';

const AVAILABILITY_META: Record<string, { label: string; className: string; icon: any }> = {
  available: { label: 'Available', className: 'chip-success', icon: CheckCircle2 },
  unverified: { label: 'Unverified', className: 'chip-muted', icon: HelpCircle },
  unknown: { label: 'Unknown', className: 'chip-muted', icon: HelpCircle },
  paid_only: { label: 'Paid only', className: 'chip-warning', icon: CircleDollarSign },
  authentication_required: { label: 'Access required', className: 'chip-warning', icon: ShieldAlert },
  unsupported: { label: 'Unsupported', className: 'chip-error', icon: XCircle },
  unavailable: { label: 'Unavailable', className: 'chip-error', icon: XCircle },
  rate_limited: { label: 'Rate limited', className: 'chip-warning', icon: Clock },
  temporarily_unavailable: { label: 'Temporarily down', className: 'chip-warning', icon: Clock },
};

const PRICING_META: Record<string, { label: string; className: string }> = {
  free: { label: 'Free', className: 'chip-success' },
  paid: { label: 'Paid', className: 'chip-warning' },
  unknown: { label: 'Unknown pricing', className: 'chip-muted' },
};

export default function ModelDashboard({ initial }: { initial?: any }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [models, setModels] = useState<RegistryModel[]>(initial?.models ?? []);
  const [overview, setOverview] = useState<Overview | null>(initial?.overview ?? null);
  const [configuration, setConfiguration] = useState<Configuration | null>(initial?.configuration ?? null);
  const [events, setEvents] = useState<EventRow[]>(initial?.recentEvents ?? []);
  const [usage, setUsage] = useState<any>(initial?.usage ?? null);
  const [loading, setLoading] = useState(!initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [availability, setAvailability] = useState('');
  const [pricing, setPricing] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [modelsRes, adminRes, usageRes] = await Promise.all([
        fetch('/api/ai/models?limit=500&overview=true').then(r => r.json()),
        fetch('/api/admin/ai/overview').then(r => r.json()),
        fetch('/api/admin/ai/usage?windowHours=24').then(r => r.json()),
      ]);
      if (modelsRes?.models) setModels(modelsRes.models);
      if (modelsRes?.overview) setOverview(modelsRes.overview);
      if (adminRes?.configuration) setConfiguration(adminRes.configuration);
      if (adminRes?.recentEvents) setEvents(adminRes.recentEvents);
      if (usageRes?.requests !== undefined) setUsage(usageRes);
    } catch (err: any) {
      toast.error(err?.message || 'Could not load the model registry.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initial) void refresh();
  }, [initial, refresh]);

  const action = useCallback(
    async (modelId: string, kind: 'verify' | 'verify-smoke' | 'enable' | 'disable' | 'primary') => {
      setBusyId(modelId);
      try {
        const encoded = encodeURIComponent(modelId);
        const paths: Record<typeof kind, string> = {
          verify: `/api/ai/models/${encoded}/verify`,
          'verify-smoke': `/api/ai/models/${encoded}/verify`,
          enable: `/api/ai/models/${encoded}/enable`,
          disable: `/api/ai/models/${encoded}/disable`,
          primary: `/api/ai/models/${encoded}/primary`,
        };
        const body =
          kind === 'verify' ? { smoke: false, force: true } : kind === 'verify-smoke' ? { smoke: true, force: true } : {};
        const res = await fetch(paths[kind], {
          method: kind === 'primary' ? 'POST' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'The action failed.');

        if (kind.startsWith('verify')) {
          const report = data as { availability: string; pricing: { status: string }; verificationError?: string; repository: { exists: boolean } };
          toast[report.availability === 'available' ? 'success' : 'warning'](
            `${modelId}: ${report.availability.replace(/_/g, ' ')} · pricing ${report.pricing?.status ?? 'unknown'}${
              report.verificationError ? ` · ${report.verificationError}` : ''
            }`,
          );
        } else {
          toast.success(`${modelId}: ${kind === 'enable' ? 'enabled' : kind === 'disable' ? 'disabled' : 'set as primary'}`);
        }
        await refresh();
      } catch (err: any) {
        toast.error(err?.message || 'The action failed.');
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return models.filter(m => {
      if (tab === 'text' && m.task !== 'text-generation') return false;
      if (tab === 'image' && m.task !== 'text-to-image') return false;
      if (category && m.category !== category) return false;
      if (availability && m.availabilityStatus !== availability) return false;
      if (pricing && m.pricingStatus !== pricing) return false;
      if (onlyEnabled && !m.enabled) return false;
      if (needle && !`${m.id} ${m.name} ${m.category} ${m.provider ?? ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [models, tab, query, category, availability, pricing, onlyEnabled]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const m of models) if ((tab === 'text' && m.task === 'text-generation') || (tab === 'image' && m.task === 'text-to-image')) set.add(m.category);
    return Array.from(set);
  }, [models, tab]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1 p-1 rounded-lg bg-[hsl(var(--surface-secondary))] border border-border">
          <TabButton active={tab === 'overview'} onClick={() => setTab('overview')} icon={Activity} label="Overview" />
          <TabButton active={tab === 'text'} onClick={() => setTab('text')} icon={Type} label={`Text models (${overview?.configured.text ?? 50})`} />
          <TabButton active={tab === 'image'} onClick={() => setTab('image')} icon={ImageIcon} label={`Image models (${overview?.configured.image ?? 20})`} />
          <TabButton active={tab === 'monitoring'} onClick={() => setTab('monitoring')} icon={Eye} label="Monitoring" />
        </div>
        <button className="btn-secondary text-xs" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
        </button>
      </div>

      {tab === 'overview' && overview && (
        <OverviewTab overview={overview} configuration={configuration} usage={usage} />
      )}

      {(tab === 'text' || tab === 'image') && (
        <div className="space-y-4">
          <div className="surface p-4 grid md:grid-cols-[1fr_auto_auto_auto_auto] gap-3 items-end">
            <div>
              <label className="label block mb-1.5">Search</label>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="input pl-9"
                  placeholder="Model id, name, category or provider"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className="label block mb-1.5">Category</label>
              <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
                <option value="">All</option>
                {categories.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label block mb-1.5">Availability</label>
              <select className="input" value={availability} onChange={e => setAvailability(e.target.value)}>
                <option value="">All</option>
                {Object.keys(AVAILABILITY_META).map(key => (
                  <option key={key} value={key}>{AVAILABILITY_META[key].label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label block mb-1.5">Pricing</label>
              <select className="input" value={pricing} onChange={e => setPricing(e.target.value)}>
                <option value="">All</option>
                {Object.entries(PRICING_META).map(([key, meta]) => (
                  <option key={key} value={key}>{meta.label}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground pb-2">
              <input type="checkbox" className="accent-primary" checked={onlyEnabled} onChange={e => setOnlyEnabled(e.target.checked)} />
              Enabled only
            </label>
          </div>

          <div className="text-xs text-muted-foreground">
            Showing {filtered.length} of {models.filter(m => (tab === 'text' ? m.task === 'text-generation' : m.task === 'text-to-image')).length} configured models.
          </div>

          <div className="surface overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <tr>
                    <th className="text-left p-3 font-semibold">Model</th>
                    <th className="text-left p-3 font-semibold">Availability</th>
                    <th className="text-left p-3 font-semibold">Pricing</th>
                    <th className="text-left p-3 font-semibold">Health</th>
                    <th className="text-left p-3 font-semibold">Verified</th>
                    <th className="text-right p-3 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(model => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      busy={busyId === model.id}
                      expanded={expanded === model.id}
                      onToggle={() => setExpanded(expanded === model.id ? null : model.id)}
                      onAction={action}
                    />
                  ))}
                  {!filtered.length && (
                    <tr>
                      <td colSpan={6} className="p-10 text-center text-muted-foreground">
                        No models match these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'monitoring' && <MonitoringTab events={events} usage={usage} />}
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: any; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition',
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  );
}

function ModelRow({
  model, busy, expanded, onToggle, onAction,
}: {
  model: RegistryModel;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onAction: (id: string, kind: 'verify' | 'verify-smoke' | 'enable' | 'disable' | 'primary') => void;
}) {
  const availability = AVAILABILITY_META[model.availabilityStatus] ?? AVAILABILITY_META.unknown;
  const pricing = PRICING_META[model.pricingStatus] ?? PRICING_META.unknown;
  const AvailabilityIcon = availability.icon;
  const limitations = safeParse<string[]>(model.limitations) ?? [];
  const adapter = safeParse<{ kind: string; baseModel?: string; weightsPath?: string }>(model.adapter);

  return (
    <>
      <tr className="border-b border-border/60 hover:bg-[hsl(var(--surface-secondary))]/60 transition">
        <td className="p-3">
          <button className="text-left" onClick={onToggle}>
            <div className="font-medium flex items-center gap-2">
              {model.name}
              {model.isPrimary && <Star className="w-3 h-3 text-primary" />}
              {!model.enabled && <span className="chip chip-muted">disabled</span>}
              {adapter && <span className="chip chip-warning">{adapter.kind}</span>}
            </div>
            <div className="text-[11px] text-muted-foreground font-mono">{model.id}</div>
          </button>
        </td>
        <td className="p-3">
          <span className={cn('chip', availability.className)}>
            <AvailabilityIcon className="w-3 h-3" /> {availability.label}
          </span>
          {model.provider && <div className="text-[11px] text-muted-foreground mt-1">via {model.provider}</div>}
        </td>
        <td className="p-3">
          <span className={cn('chip', pricing.className)}>{pricing.label}</span>
        </td>
        <td className="p-3 text-xs text-muted-foreground">
          <div>{model.successCount} ok · {model.failureCount} failed</div>
          {model.averageLatencyMs ? <div>~{(model.averageLatencyMs / 1000).toFixed(1)}s avg</div> : <div>no latency data</div>}
        </td>
        <td className="p-3 text-xs text-muted-foreground">
          <div>{model.verificationSource.replace(/-/g, ' ')}</div>
          <div>{model.lastCheckedAt ? new Date(model.lastCheckedAt).toLocaleString() : 'never checked'}</div>
        </td>
        <td className="p-3">
          <div className="flex flex-wrap justify-end gap-1.5">
            <button className="btn-outline text-[11px] px-2 py-1" disabled={busy} onClick={() => onAction(model.id, 'verify')}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />} Verify
            </button>
            <button className="btn-outline text-[11px] px-2 py-1" disabled={busy} onClick={() => onAction(model.id, 'verify-smoke')}>
              <Sparkles className="w-3 h-3" /> Smoke test
            </button>
            <button className="btn-outline text-[11px] px-2 py-1" disabled={busy} onClick={() => onAction(model.id, model.enabled ? 'disable' : 'enable')}>
              {model.enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn-outline text-[11px] px-2 py-1" disabled={busy || model.isPrimary} onClick={() => onAction(model.id, 'primary')}>
              <Star className="w-3 h-3" /> Primary
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/60 bg-[hsl(var(--surface-secondary))]/40">
          <td colSpan={6} className="p-4 text-xs space-y-2">
            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <div className="label mb-1">Repository</div>
                <div>Category: {model.category}</div>
                <div>License: {model.license ?? 'unknown'}</div>
                <div>Verified: {model.verified ? 'yes' : 'no'}{model.verifiedAt ? ` · ${new Date(model.verifiedAt).toLocaleString()}` : ''}</div>
              </div>
              <div>
                <div className="label mb-1">Capabilities</div>
                <div>Task: {model.task}</div>
                {model.task === 'text-generation' ? (
                  <div>Context: {model.contextLength ? model.contextLength.toLocaleString() : 'unknown'}</div>
                ) : (
                  <div>
                    Sizes: {model.supportedSizes ? (safeParse<Array<{ width: number; height: number }>>(model.supportedSizes) ?? []).map(s => `${s.width}×${s.height}`).join(', ') || 'unverified' : 'unverified'}
                    <br />
                    Negative prompt: {model.supportsNegativePrompt === null ? 'unverified' : model.supportsNegativePrompt ? 'yes' : 'no'}
                  </div>
                )}
                <div>Last success: {model.lastSuccessfulAt ? new Date(model.lastSuccessfulAt).toLocaleString() : 'never'}</div>
              </div>
              <div>
                <div className="label mb-1">Status</div>
                <div>Enabled: {model.enabled ? 'yes' : 'no'}</div>
                {model.disabledReason && <div>Reason: {model.disabledReason}</div>}
                {adapter && <div>Adapter: {adapter.kind}{adapter.weightsPath ? ` (${adapter.weightsPath})` : ''} — needs a base model</div>}
              </div>
            </div>
            {limitations.length > 0 && (
              <div>
                <div className="label mb-1">Known limitations</div>
                <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                  {limitations.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function OverviewTab({ overview, configuration, usage }: { overview: Overview; configuration: Configuration | null; usage: any }) {
  const cards = [
    { label: 'Configured models', value: overview.configured.total, hint: `${overview.configured.text} text · ${overview.configured.image} image`, icon: Cpu },
    { label: 'Verified repositories', value: overview.verifiedRepositories, hint: 'Repository confirmed to exist on the Hub', icon: CheckCircle2 },
    { label: 'Hosted inference supported', value: overview.hostedInferenceSupported, hint: 'A provider is mapped or a call succeeded', icon: Sparkles },
    { label: 'Live-inference tested', value: overview.successfullyTested, hint: 'Completed a real inference request', icon: Activity },
    { label: 'Unavailable', value: overview.unavailable, hint: 'No provider serves the model', icon: XCircle },
    { label: 'Unsupported', value: overview.unsupported, hint: 'Architecture/task unsupported', icon: AlertTriangle },
    { label: 'Access required', value: overview.authenticationRequired, hint: 'Gated or not granted to this account', icon: ShieldAlert },
    { label: 'Unknown pricing', value: overview.byPricing.unknown ?? 0, hint: 'Never treated as free', icon: HelpCircle },
    { label: 'Confirmed free', value: overview.byPricing.free ?? 0, hint: 'Provider reports no charge', icon: CircleDollarSign },
    { label: 'Paid', value: overview.byPricing.paid ?? 0, hint: 'Skipped when paid inference is disabled', icon: CircleDollarSign },
    { label: 'Disabled', value: overview.disabled, hint: 'Excluded from selection', icon: XCircle },
    { label: 'Recent failures', value: overview.recentFailures, hint: `${overview.recentSuccesses} recent successes`, icon: AlertTriangle },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        {cards.map(card => (
          <div key={card.label} className="surface p-4">
            <div className="flex items-center gap-2 label mb-2">
              <card.icon className="w-3.5 h-3.5" /> {card.label}
            </div>
            <div className="font-serif text-2xl font-semibold">{card.value}</div>
            <p className="text-[11px] text-muted-foreground mt-1">{card.hint}</p>
          </div>
        ))}
      </div>

      {configuration && (
        <div className="surface p-5">
          <div className="label mb-3">Active policy</div>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            <PolicyRow label="Backend" value={configuration.backend} />
            <PolicyRow label="Hugging Face token" value={configuration.huggingFaceConfigured ? 'configured' : 'missing'} />
            <PolicyRow label="Paid inference" value={configuration.allowPaidInference ? 'allowed' : 'blocked (free-only)'} />
            <PolicyRow label="Confirmed pricing required" value={configuration.requireConfirmedPricing ? 'yes' : 'no'} />
            <PolicyRow label="Automatic fallback" value={configuration.fallbackEnabled ? `yes (max ${configuration.maxFallbackAttempts})` : 'no'} />
            <PolicyRow label="Request timeout" value={`${Math.round(configuration.requestTimeoutMs / 1000)}s`} />
            <PolicyRow label="Health-check interval" value={`${configuration.healthCheckIntervalHours}h`} />
            <PolicyRow label="Per-user limits" value={`${configuration.maxTextRequestsPerUserPerHour} text/h · ${configuration.maxImageRequestsPerUserPerHour} image/h`} />
            <PolicyRow label="Router" value={configuration.routerBaseUrl} />
            <PolicyRow label="Primary text model" value={overview.primary.text ?? 'none'} />
            <PolicyRow label="Primary image model" value={overview.primary.image ?? 'none'} />
          </div>
          {!configuration.huggingFaceConfigured && (
            <p className="text-xs text-amber-400 mt-4 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5" />
              HF_TOKEN is not configured, so no model can be verified or called. Set it in the environment, then run verification to
              populate real availability and pricing.
            </p>
          )}
        </div>
      )}

      {usage && (
        <div className="surface p-5">
          <div className="label mb-3">Usage (last {usage.windowHours}h)</div>
          <div className="grid md:grid-cols-4 gap-4 text-xs">
            <PolicyRow label="Requests" value={String(usage.requests)} />
            <PolicyRow label="Tokens" value={`${(usage.inputTokens ?? 0).toLocaleString()} in / ${(usage.outputTokens ?? 0).toLocaleString()} out`} />
            <PolicyRow label="Estimated cost" value={`$${(usage.estimatedCostUsd ?? 0).toFixed(4)}`} />
            <PolicyRow label="Unknown-cost requests" value={String(usage.unknownCostRequests ?? 0)} />
          </div>
          {usage.byModel?.length ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="text-left p-2">Model</th>
                    <th className="text-left p-2">Provider</th>
                    <th className="text-right p-2">Requests</th>
                    <th className="text-right p-2">Fallbacks</th>
                    <th className="text-right p-2">Est. cost</th>
                    <th className="text-left p-2">Cost status</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byModel.slice(0, 10).map((row: any) => (
                    <tr key={`${row.model}-${row.provider}`} className="border-t border-border/60">
                      <td className="p-2 font-mono">{row.model}</td>
                      <td className="p-2">{row.provider ?? '—'}</td>
                      <td className="p-2 text-right">{row.requests}</td>
                      <td className="p-2 text-right">{row.fallbackCount}</td>
                      <td className="p-2 text-right">${(row.estimatedCostUsd ?? 0).toFixed(4)}</td>
                      <td className="p-2">{row.costStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function MonitoringTab({ events, usage }: { events: EventRow[]; usage: any }) {
  return (
    <div className="space-y-6">
      <div className="surface p-5">
        <div className="label mb-3">Recent model events</div>
        {!events.length ? (
          <p className="text-sm text-muted-foreground">No verification or inference events yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left p-2">When</th>
                  <th className="text-left p-2">Model</th>
                  <th className="text-left p-2">Kind</th>
                  <th className="text-left p-2">Result</th>
                  <th className="text-left p-2">Category</th>
                  <th className="text-left p-2">Provider</th>
                  <th className="text-right p-2">Latency</th>
                  <th className="text-left p-2">Message</th>
                </tr>
              </thead>
              <tbody>
                {events.map(event => (
                  <tr key={event.id} className="border-t border-border/60">
                    <td className="p-2 whitespace-nowrap">{new Date(event.createdAt).toLocaleString()}</td>
                    <td className="p-2 font-mono">{event.modelId}</td>
                    <td className="p-2">{event.kind}</td>
                    <td className="p-2">
                      <span className={cn('chip', event.ok ? 'chip-success' : 'chip-error')}>{event.ok ? 'ok' : 'failed'}</span>
                    </td>
                    <td className="p-2">{event.category ?? '—'}</td>
                    <td className="p-2">{event.provider ?? '—'}</td>
                    <td className="p-2 text-right">{event.latencyMs ? `${event.latencyMs}ms` : '—'}</td>
                    <td className="p-2 text-muted-foreground max-w-md truncate">{event.message ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {usage?.byModel?.length ? (
        <div className="surface p-5">
          <div className="label mb-3">Usage by model (last {usage.windowHours}h)</div>
          <p className="text-xs text-muted-foreground">
            Costs are labelled confirmed (provider-reported), estimated (computed from published prices) or unknown. Unknown is never
            shown as zero.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium break-words">{value}</div>
    </div>
  );
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
