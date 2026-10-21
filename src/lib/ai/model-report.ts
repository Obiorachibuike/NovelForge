/**
 * MODEL_STATUS.md generator.
 *
 * The report is produced from persisted registry state, so it can only ever say
 * what has actually been observed. Anything not verified is reported as
 * unverified — including, before a verification run, all 70 models.
 */
import 'server-only';
import { getDb } from '@/lib/db';
import { getModelRow, listModelRows, registryOverview, syncRegistry } from './model-registry';
import { EXPECTED_IMAGE_MODEL_COUNT, EXPECTED_TEXT_MODEL_COUNT, limitationFor } from './models';
import { MODEL_AVAILABILITY_LABELS, MODEL_PRICING_LABELS, type ModelRow } from './types';

export interface ModelStatusReport {
  generatedAt: string;
  overview: ReturnType<typeof registryOverview>;
  rows: ModelRow[];
  tokenConfigured: boolean;
}

function safeParse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Collects everything the report needs from the database. */
export function collectModelStatus(tokenConfigured: boolean): ModelStatusReport {
  syncRegistry();
  return {
    generatedAt: new Date().toISOString(),
    overview: registryOverview(),
    rows: listModelRows({ limit: 500 }),
    tokenConfigured,
  };
}

function cell(value: string | null | undefined, fallback = '—'): string {
  const text = (value ?? '').trim();
  return text ? text.replace(/\|/g, '\\|') : fallback;
}

function limitationsCell(row: ModelRow): string {
  const stored = safeParse<string[]>(row.limitations) ?? [];
  const combined = stored.length ? stored : limitationFor(row.id);
  if (!combined.length) return '—';
  const first = combined.slice(0, 2).join(' ').replace(/\|/g, '\\|');
  return first.length > 220 ? `${first.slice(0, 219)}…` : first;
}

/** Renders the Markdown report. */
export function renderModelStatus(report: ModelStatusReport): string {
  const { overview, rows } = report;
  const text = rows.filter(r => r.task === 'text-generation');
  const image = rows.filter(r => r.task === 'text-to-image');
  const availabilityCount = (status: string) => rows.filter(r => r.availabilityStatus === status).length;
  const pricingCount = (status: string) => rows.filter(r => r.pricingStatus === status).length;

  const lines: string[] = [];
  lines.push('# Model status report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(
    '> This report is generated from NovelForge\'s persisted model registry. "Configured" means the model ID is part of the ' +
      'requested registry; it does **not** mean the model is served by a hosted provider, reachable by this account, or free. ' +
      'Regenerate it after a verification run with `npm run ai:models:report`.',
  );
  lines.push('');
  if (!report.tokenConfigured) {
    lines.push(
      '> **No Hugging Face token was configured when this report was generated.** Every model below is therefore unverified: ' +
        'no repository check, provider lookup or live inference was performed. Set `HF_TOKEN` and run `npm run ai:verify` to ' +
        'populate real statuses.',
    );
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Configured text models | ${EXPECTED_TEXT_MODEL_COUNT} |`);
  lines.push(`| Configured image models | ${EXPECTED_IMAGE_MODEL_COUNT} |`);
  lines.push(`| Registered rows | ${rows.length} |`);
  lines.push(`| Repositories verified on the Hub | ${overview.verifiedRepositories} |`);
  lines.push(`| Hosted inference supported | ${overview.hostedInferenceSupported} |`);
  lines.push(`| Successfully live-tested | ${overview.successfullyTested} |`);
  lines.push(`| Unavailable | ${availabilityCount('unavailable')} |`);
  lines.push(`| Unsupported | ${availabilityCount('unsupported')} |`);
  lines.push(`| Access/gating required | ${availabilityCount('authentication_required')} |`);
  lines.push(`| Paid only (availability) | ${availabilityCount('paid_only')} |`);
  lines.push(`| Unverified | ${availabilityCount('unverified')} |`);
  lines.push(`| Pricing: confirmed free | ${pricingCount('free')} |`);
  lines.push(`| Pricing: paid | ${pricingCount('paid')} |`);
  lines.push(`| Pricing: unknown | ${pricingCount('unknown')} |`);
  lines.push(`| Enabled for selection | ${overview.enabled} |`);
  lines.push(`| Disabled by an administrator | ${overview.disabled} |`);
  lines.push('');

  lines.push('## How to read the columns');
  lines.push('');
  lines.push('- **Repository** — the Hub repository was found (metadata check).');
  lines.push('- **Hosted** — a provider is mapped to the model for the required task (provider-mapping/router-catalog check).');
  lines.push('- **Live test** — an actual inference request completed successfully. This is the only column that proves end-to-end operation.');
  lines.push('- **Pricing** — `free`/`paid` come from provider pricing data; `unknown` is never treated as free.');
  lines.push('');

  for (const [title, list] of [
    ['Text models', text],
    ['Image models', image],
  ] as Array<[string, ModelRow[]]>) {
    lines.push(`## ${title} (${list.length})`);
    lines.push('');
    lines.push('| # | Model ID | Category | Repository | Hosted | Live test | Pricing | License | Last verified | Limitations |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    list.forEach((row, index) => {
      const repository = row.verified ? 'yes' : row.verificationSource === 'unverified' ? 'not checked' : 'no';
      const hosted = row.provider ? `yes (${row.provider})` : row.availabilityStatus === 'available' ? 'yes' : row.availabilityStatus === 'unverified' ? 'not checked' : 'no';
      const live = row.verificationSource === 'live-inference' || row.successCount > 0 ? 'passed' : 'not run';
      lines.push(
        `| ${index + 1} | \`${row.id}\` | ${cell(row.category)} | ${repository} | ${hosted} | ${live} | ${MODEL_PRICING_LABELS[row.pricingStatus]} | ${cell(row.license)} | ${cell(row.lastCheckedAt)} | ${limitationsCell(row)} |`,
      );
    });
    lines.push('');
  }

  lines.push('## Notes on specific model architectures');
  lines.push('');
  lines.push(
    '- **Adapters / LoRA weights** (for example `XLabs-AI/flux-RealismLora`) are not standalone text-to-image models. NovelForge keeps ' +
      'the requested ID, records the adapter metadata reported by the provider mapping, and marks the model as needing a base model. ' +
      'Adapter composition is only attempted when the hosted provider actually supports it.',
  );
  lines.push(
    '- **Cascaded pipelines** (for example `DeepFloyd/IF-I-XL-v1.0`) return a low-resolution stage-I image from a single hosted call.',
  );
  lines.push(
    '- **Gated repositories** (Llama, Gemma, FLUX.1-dev, SD3.5) require the account to accept the model terms before inference is possible.',
  );
  lines.push('');

  return lines.join('\n');
}

/** Convenience for the CLI: build and render in one call. */
export function buildModelStatusMarkdown(tokenConfigured: boolean): string {
  return renderModelStatus(collectModelStatus(tokenConfigured));
}

/** Machine-readable snapshot (used by `docs/model-status.json`). */
export function buildModelStatusJson(tokenConfigured: boolean) {
  const report = collectModelStatus(tokenConfigured);
  return {
    generatedAt: report.generatedAt,
    tokenConfigured,
    overview: report.overview,
    models: report.rows.map(row => ({
      id: row.id,
      task: row.task,
      category: row.category,
      availability: MODEL_AVAILABILITY_LABELS[row.availabilityStatus],
      availabilityStatus: row.availabilityStatus,
      pricing: MODEL_PRICING_LABELS[row.pricingStatus],
      pricingStatus: row.pricingStatus,
      provider: row.provider,
      license: row.license,
      verified: row.verified,
      verificationSource: row.verificationSource,
      liveTestPassed: row.verificationSource === 'live-inference' || row.successCount > 0,
      enabled: row.enabled,
      lastCheckedAt: row.lastCheckedAt,
      lastSuccessfulAt: row.lastSuccessfulAt,
      averageLatencyMs: row.averageLatencyMs,
      failureCount: row.failureCount,
      successCount: row.successCount,
      limitations: safeParse<string[]>(row.limitations) ?? limitationFor(row.id),
    })),
  };
}

/** Used by the script to report a single model without a full scan. */
export function modelSnapshot(modelId: string) {
  void getDb;
  return getModelRow(modelId);
}
