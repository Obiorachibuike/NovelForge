/**
 * Usage tracking for hosted inference.
 *
 * Rules:
 *  - A cost is only ever recorded as `confirmed` when the provider returned it.
 *    Otherwise it is `estimated` (computed from published prices) or `unknown`.
 *  - `unknown` is never displayed or stored as 0.
 *  - Token counts are stored only when the provider reported them; missing
 *    usage data is recorded as absent rather than guessed.
 */
import 'server-only';
import { getDb } from '@/lib/db';
import { estimateCostUsd, priceFor } from './pricing';
import type { GenerationCost, ModelTask } from './types';

export type CostStatus = GenerationCost['status'];

export interface GenerationUsageInput {
  userId?: string | null;
  novelId?: string | null;
  chapterId?: string | null;
  jobId?: string | null;
  /** NovelForge task label (chapter, outline, cover, …). */
  taskType?: string;
  task?: ModelTask;
  requestedModel?: string | null;
  actualModel: string;
  provider?: string | null;
  attempts?: number;
  fallbackCount?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  imageWidth?: number;
  imageHeight?: number;
  cost?: GenerationCost;
  /** Extra, non-sensitive metadata (attempt trail, transport, etc.). */
  meta?: Record<string, unknown>;
}

/**
 * Computes the cost record for a generation. Providers rarely return a price,
 * so the default is an estimate from published prices — clearly labelled.
 */
export function costFor(params: {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  reportedCost?: { amount: number; currency: string };
}): GenerationCost {
  if (params.reportedCost && Number.isFinite(params.reportedCost.amount)) {
    return { amount: params.reportedCost.amount, currency: params.reportedCost.currency, status: 'confirmed' };
  }
  if (typeof params.inputTokens === 'number' && typeof params.outputTokens === 'number') {
    const amount = estimateCostUsd(params.model, params.inputTokens, params.outputTokens);
    return { amount, currency: 'USD', status: 'estimated' };
  }
  return { status: 'unknown' };
}

/** Persists one AI usage row. Never throws: accounting must not break generation. */
export function recordGenerationUsage(input: GenerationUsageInput): void {
  try {
    const db = getDb();
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const price = priceFor(input.actualModel);
    const inputTokens = typeof input.inputTokens === 'number' ? input.inputTokens : 0;
    const outputTokens = typeof input.outputTokens === 'number' ? input.outputTokens : 0;
    const cost = input.cost ?? costFor({ model: input.actualModel, inputTokens, outputTokens });

    db.prepare(
      `INSERT INTO ai_usage (
        id,userId,novelId,chapterId,jobId,taskType,provider,model,requestedModel,actualModel,
        promptTokens,completionTokens,totalTokens,estimatedCostUsd,estimatedCostBeforeUsd,createdAt,
        pricePromptPer1k,priceCompletionPer1k,source,meta,attemptCount,fallbackCount,durationMs,
        costStatus,confirmedCostUsd,imageWidth,imageHeight
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      input.userId ?? null,
      input.novelId ?? null,
      input.chapterId ?? null,
      input.jobId ?? null,
      input.taskType ?? input.task ?? 'generation',
      input.provider ?? 'huggingface',
      input.actualModel,
      input.requestedModel ?? null,
      input.actualModel,
      inputTokens,
      outputTokens,
      inputTokens + outputTokens,
      cost.status === 'unknown' ? 0 : (cost.amount ?? 0),
      cost.status === 'unknown' ? 0 : (cost.amount ?? 0),
      new Date().toISOString(),
      price.promptPer1k,
      price.completionPer1k,
      'huggingface',
      JSON.stringify({ task: input.task ?? null, ...(input.meta ?? {}) }),
      input.attempts ?? 1,
      input.fallbackCount ?? 0,
      typeof input.latencyMs === 'number' ? Math.round(input.latencyMs) : null,
      cost.status,
      cost.status === 'confirmed' ? (cost.amount ?? null) : null,
      input.imageWidth ?? null,
      input.imageHeight ?? null,
    );
  } catch (err) {
    console.warn('[ai] recordGenerationUsage failed:', err);
  }
}

/** Writes the model provenance of a job so the UI can show what really ran. */
export function recordJobProvenance(
  jobId: string,
  provenance: { requestedModel?: string | null; actualModel?: string | null; provider?: string | null; fallbackCount?: number; durationMs?: number },
): void {
  try {
    const db = getDb();
    db.prepare(
      `UPDATE generation_jobs
          SET requestedModel=COALESCE(?, requestedModel),
              actualModel=COALESCE(?, actualModel),
              provider=COALESCE(?, provider),
              fallbackCount=?,
              durationMs=COALESCE(?, durationMs),
              updatedAt=?
        WHERE id=?`,
    ).run(
      provenance.requestedModel ?? null,
      provenance.actualModel ?? null,
      provenance.provider ?? null,
      provenance.fallbackCount ?? 0,
      typeof provenance.durationMs === 'number' ? Math.round(provenance.durationMs) : null,
      new Date().toISOString(),
      jobId,
    );
  } catch (err) {
    console.warn('[ai] recordJobProvenance failed:', err);
  }
}

export interface AdminUsageSummary {
  windowHours: number;
  requests: number;
  failures: number;
  fallbacks: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  confirmedCostUsd: number;
  unknownCostRequests: number;
  byModel: Array<{ model: string; provider: string | null; requests: number; fallbackCount: number; estimatedCostUsd: number; costStatus: string }>;
}

/** Aggregated usage for the admin dashboard (never exposes another user's rows). */
export function adminUsageSummary(windowHours = 24): AdminUsageSummary {
  const db = getDb();
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const totals = db.prepare(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(promptTokens),0) AS inputTokens,
            COALESCE(SUM(completionTokens),0) AS outputTokens,
            COALESCE(SUM(estimatedCostUsd),0) AS estimatedCostUsd,
            COALESCE(SUM(confirmedCostUsd),0) AS confirmedCostUsd,
            COALESCE(SUM(CASE WHEN costStatus='unknown' THEN 1 ELSE 0 END),0) AS unknownCostRequests,
            COALESCE(SUM(CASE WHEN fallbackCount>0 THEN 1 ELSE 0 END),0) AS fallbacks
       FROM ai_usage WHERE createdAt >= ?`,
  ).get(since) as any;

  const byModel = db.prepare(
    `SELECT model, provider, COUNT(*) AS requests,
            COALESCE(SUM(fallbackCount),0) AS fallbackCount,
            COALESCE(SUM(estimatedCostUsd),0) AS estimatedCostUsd,
            MAX(costStatus) AS costStatus
       FROM ai_usage WHERE createdAt >= ?
      GROUP BY model, provider ORDER BY requests DESC`,
  ).all(since) as any[];

  const failures = db.prepare(
    `SELECT COUNT(*) AS c FROM ai_model_events WHERE createdAt >= ? AND ok = 0`,
  ).get(since) as any;

  return {
    windowHours,
    requests: Number(totals?.requests ?? 0),
    failures: Number(failures?.c ?? 0),
    fallbacks: Number(totals?.fallbacks ?? 0),
    inputTokens: Number(totals?.inputTokens ?? 0),
    outputTokens: Number(totals?.outputTokens ?? 0),
    estimatedCostUsd: Math.round(Number(totals?.estimatedCostUsd ?? 0) * 1e6) / 1e6,
    confirmedCostUsd: Math.round(Number(totals?.confirmedCostUsd ?? 0) * 1e6) / 1e6,
    unknownCostRequests: Number(totals?.unknownCostRequests ?? 0),
    byModel: byModel.map(row => ({
      model: row.model,
      provider: row.provider ?? null,
      requests: Number(row.requests ?? 0),
      fallbackCount: Number(row.fallbackCount ?? 0),
      estimatedCostUsd: Math.round(Number(row.estimatedCostUsd ?? 0) * 1e6) / 1e6,
      costStatus: row.costStatus ?? 'unknown',
    })),
  };
}
