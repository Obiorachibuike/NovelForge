import 'server-only';
import { getDb } from '@/lib/db';
import { nanoid } from 'nanoid';
import { HttpError } from '@/lib/api/http';
import { estimateCostUsd, estimateImageCostUsd, priceFor } from './pricing';

/**
 * Per-user AI spend accounting and enforcement.
 *
 * Every successful provider call writes one `ai_usage` row (model, task, tokens,
 * estimated cost, source). Before a request is issued the caller must pass
 * `assertAiBudget`, which sums the current window from the same table — so the
 * limit holds across processes and survives restarts, unlike an in-memory
 * counter.
 */
export interface AiBudget {
  /** Tokens per user per rolling 24 hours. 0 disables the check. */
  dailyTokenLimit: number;
  /** Estimated USD per user per rolling 30 days. 0 disables the check. */
  monthlyCostLimitUsd: number;
  /** Hard ceiling on a single completion's completion tokens. */
  maxCompletionTokens: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export function getAiBudget(): AiBudget {
  return {
    dailyTokenLimit: envNumber('AI_DAILY_TOKEN_LIMIT', 400_000),
    monthlyCostLimitUsd: envNumber('AI_MONTHLY_COST_LIMIT_USD', 25),
    maxCompletionTokens: envNumber('AI_MAX_COMPLETION_TOKENS', 8000),
  };
}

export interface AiUsageSummary {
  windowHours: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  byTask: Array<{ taskType: string; model: string; requests: number; totalTokens: number; estimatedCostUsd: number }>;
}

export function usageSummary(userId: string, windowHours = 24): AiUsageSummary {
  const db = getDb();
  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
  const totals = db.prepare(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(promptTokens),0) AS promptTokens,
            COALESCE(SUM(completionTokens),0) AS completionTokens,
            COALESCE(SUM(totalTokens),0) AS totalTokens,
            COALESCE(SUM(estimatedCostUsd),0) AS estimatedCostUsd
       FROM ai_usage WHERE userId = ? AND createdAt >= ?`,
  ).get(userId, since) as any;
  const byTask = db.prepare(
    `SELECT taskType, model, COUNT(*) AS requests,
            COALESCE(SUM(totalTokens),0) AS totalTokens,
            COALESCE(SUM(estimatedCostUsd),0) AS estimatedCostUsd
       FROM ai_usage WHERE userId = ? AND createdAt >= ?
      GROUP BY taskType, model ORDER BY estimatedCostUsd DESC`,
  ).all(userId, since) as any[];
  return {
    windowHours,
    requests: totals?.requests ?? 0,
    promptTokens: totals?.promptTokens ?? 0,
    completionTokens: totals?.completionTokens ?? 0,
    totalTokens: totals?.totalTokens ?? 0,
    estimatedCostUsd: Math.round((totals?.estimatedCostUsd ?? 0) * 1e6) / 1e6,
    byTask,
  };
}

export interface BudgetCheck {
  allowed: boolean;
  reason?: string;
  dailyTokensUsed: number;
  monthlyCostUsedUsd: number;
}

/** Non-throwing budget probe, used by /api/usage and tests. */
export function checkAiBudget(userId: string, estimatedTokens = 0): BudgetCheck {
  const budget = getAiBudget();
  const day = usageSummary(userId, 24);
  const month = usageSummary(userId, 24 * 30);
  const dailyTokensUsed = day.totalTokens + Math.max(0, estimatedTokens);
  if (budget.dailyTokenLimit > 0 && dailyTokensUsed > budget.dailyTokenLimit) {
    return {
      allowed: false,
      reason: `Daily AI token limit reached (${budget.dailyTokenLimit.toLocaleString()} tokens per 24h).`,
      dailyTokensUsed,
      monthlyCostUsedUsd: month.estimatedCostUsd,
    };
  }
  if (budget.monthlyCostLimitUsd > 0 && month.estimatedCostUsd >= budget.monthlyCostLimitUsd) {
    return {
      allowed: false,
      reason: `Monthly AI budget reached ($${budget.monthlyCostLimitUsd.toFixed(2)} estimated).`,
      dailyTokensUsed,
      monthlyCostUsedUsd: month.estimatedCostUsd,
    };
  }
  return { allowed: true, dailyTokensUsed, monthlyCostUsedUsd: month.estimatedCostUsd };
}

/** Throws a 429 when the user is out of AI budget. Call before every provider request. */
export function assertAiBudget(userId: string, estimatedTokens = 0): void {
  const check = checkAiBudget(userId, estimatedTokens);
  if (!check.allowed) {
    throw new HttpError(429, check.reason || 'AI budget exhausted.', 'ai_budget_exhausted');
  }
}

/** Clamps a requested completion size to the configured ceiling. */
export function clampCompletionTokens(requested?: number): number {
  const { maxCompletionTokens } = getAiBudget();
  if (!requested || requested <= 0) return Math.min(2048, maxCompletionTokens);
  return Math.min(Math.round(requested), maxCompletionTokens);
}

export interface UsageRecord {
  userId: string;
  novelId?: string | null;
  taskType: string;
  provider?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** 'openai' for real calls, 'demo' for deliberate demo-mode output. */
  source?: 'openai' | 'demo' | 'stub';
  meta?: Record<string, unknown>;
}

/** Writes one usage row. Never throws: accounting must not break a generation. */
export function recordUsage(input: UsageRecord): void {
  try {
    const db = getDb();
    const price = priceFor(input.model);
    const cost = input.source === 'demo' || input.source === 'stub'
      ? 0
      : estimateCostUsd(input.model, input.promptTokens, input.completionTokens);
    db.prepare(
      `INSERT INTO ai_usage (id,userId,novelId,taskType,provider,model,promptTokens,completionTokens,
                             totalTokens,estimatedCostUsd,createdAt,pricePromptPer1k,priceCompletionPer1k,source,meta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      nanoid(), input.userId, input.novelId || null, input.taskType,
      input.provider || 'openai', input.model, input.promptTokens, input.completionTokens,
      input.promptTokens + input.completionTokens, cost, new Date().toISOString(),
      price.promptPer1k, price.completionPer1k, input.source || 'openai',
      input.meta ? JSON.stringify(input.meta) : null,
    );
  } catch (err) {
    console.warn('[ai] recordUsage failed:', err);
  }
}

/** Records one image generation (priced per image rather than per token). */
export function recordImageUsage(input: { userId: string; novelId?: string | null; model: string; images: number; source?: 'openai' | 'demo' }) {
  try {
    const db = getDb();
    const cost = input.source === 'demo' ? 0 : estimateImageCostUsd(input.model, input.images);
    db.prepare(
      `INSERT INTO ai_usage (id,userId,novelId,taskType,provider,model,promptTokens,completionTokens,
                             totalTokens,estimatedCostUsd,createdAt,pricePromptPer1k,priceCompletionPer1k,source,meta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      nanoid(), input.userId, input.novelId || null, 'cover', 'openai', input.model,
      0, 0, 0, cost, new Date().toISOString(), 0, 0,
      input.source || 'openai', JSON.stringify({ images: input.images }),
    );
  } catch (err) {
    console.warn('[ai] recordImageUsage failed:', err);
  }
}
