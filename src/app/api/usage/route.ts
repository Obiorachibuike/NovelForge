import { requireUser } from '@/lib/db/ownership';
import { apiHandler } from '@/lib/api/http';
import { usageSummary, getAiBudget, checkAiBudget } from '@/lib/ai/usage';
import { storageInfo } from '@/lib/storage';
import { queueInfo } from '@/lib/queue';

/**
 * Per-user AI accounting plus the limits in force, so the UI can warn before a
 * generation is refused.
 */
export const GET = apiHandler(async () => {
  const user = await requireUser();
  const budget = getAiBudget();
  const day = usageSummary(user.id, 24);
  const month = usageSummary(user.id, 24 * 30);
  const check = checkAiBudget(user.id);
  return Response.json({
    daily: day,
    monthly: month,
    limits: {
      dailyTokenLimit: budget.dailyTokenLimit,
      monthlyCostLimitUsd: budget.monthlyCostLimitUsd,
      maxCompletionTokens: budget.maxCompletionTokens,
      remainingDailyTokens: Math.max(0, budget.dailyTokenLimit - day.totalTokens),
      remainingMonthlyUsd: Math.max(0, budget.monthlyCostLimitUsd - month.estimatedCostUsd),
    },
    allowed: check.allowed,
    reason: check.reason ?? null,
    storage: await storageInfo(),
    queue: queueInfo(),
  });
});
