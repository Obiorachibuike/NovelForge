import { requireUser, requireNovel } from '@/lib/db/ownership';
import { apiHandler } from '@/lib/api/http';
import { usageSummary, novelUsageSummary, getAiBudget, checkAiBudget } from '@/lib/ai/usage';
import { estimateOperationCost } from '@/lib/ai/pricing';
import { aiConfig } from '@/lib/ai/provider';
import { storageInfo } from '@/lib/storage';
import { queueInfo } from '@/lib/queue';

/**
 * Per-user AI accounting plus the limits in force, optional per-novel usage,
 * and pre-operation cost estimation.
 */
export const GET = apiHandler(async (req?: Request) => {
  const user = await requireUser();
  const budget = getAiBudget();
  const day = usageSummary(user.id, 24);
  const month = usageSummary(user.id, 24 * 30);
  const check = checkAiBudget(user.id);

  let novelUsage: ReturnType<typeof novelUsageSummary> | undefined;
  let estimate: ReturnType<typeof estimateOperationCost> | undefined;

  if (req?.url) {
    const url = new URL(req.url);
    const novelId = url.searchParams.get('novelId');
    if (novelId) {
      await requireNovel(novelId, user.id);
      novelUsage = novelUsageSummary(user.id, novelId);
    }
    const estimateTask = url.searchParams.get('estimateTask');
    if (estimateTask) {
      const targetWords = Number(url.searchParams.get('targetWords') || '') || undefined;
      const imageVariants = Number(url.searchParams.get('variants') || '') || undefined;
      estimate = estimateOperationCost({
        taskType: estimateTask,
        targetWords,
        imageVariants,
        demoMode: aiConfig.demoMode,
      });
    }
  }

  return Response.json({
    daily: day,
    monthly: month,
    ...(novelUsage ? { novel: novelUsage, novelUsage } : {}),
    ...(estimate ? { estimate } : {}),
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
