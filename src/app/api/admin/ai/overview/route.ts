import { requireUser } from '@/lib/db/ownership';
import { apiHandler } from '@/lib/api/http';
import { requireAdmin } from '@/services/billing/service';
import { registryOverview, recentModelEvents, syncRegistry } from '@/lib/ai/model-registry';
import { aiPolicy, aiProviderSummary, huggingFaceConfigured } from '@/lib/ai/config';

export const dynamic = 'force-dynamic';

/**
 * Administrator overview of the hosted-inference layer.
 *
 * Every count is derived from persisted evidence: a configured model is never
 * reported as operational until verification or a live inference says so.
 */
export const GET = apiHandler(async (_req: Request) => {
  const user = await requireUser();
  requireAdmin(user.id);
  syncRegistry();

  const policy = aiPolicy();
  const summary = aiProviderSummary();
  const overview = registryOverview();
  return Response.json({
    overview,
    recentEvents: recentModelEvents({ limit: 25 }),
    recentFailures: recentModelEvents({ limit: 25, onlyFailures: true }),
    configuration: {
      backend: policy.backend,
      // Agnes AI is the primary provider, so its state belongs next to the
      // Hugging Face fallback in the console instead of being invisible.
      agnesConfigured: policy.agnesConfigured,
      agnesTextModel: policy.agnesTextModel,
      agnesImageModel: policy.agnesImageModel,
      agnesBaseUrl: policy.agnesBaseUrl,
      providerOrder: summary.providerOrder,
      pinnedBackend: summary.pinnedBackend,
      providerProblems: summary.problems,
      huggingFaceConfigured: huggingFaceConfigured(),
      allowPaidInference: policy.allowPaidInference,
      requireConfirmedPricing: policy.requireConfirmedPricing,
      fallbackEnabled: policy.fallbackEnabled,
      maxFallbackAttempts: policy.maxFallbackAttempts,
      requestTimeoutMs: policy.requestTimeoutMs,
      healthCheckEnabled: policy.healthCheckEnabled,
      healthCheckIntervalHours: policy.healthCheckIntervalHours,
      maxTextRequestsPerUserPerHour: policy.maxTextRequestsPerUserPerHour,
      maxImageRequestsPerUserPerHour: policy.maxImageRequestsPerUserPerHour,
      routerBaseUrl: policy.routerBaseUrl,
    },
  });
});
