import { requireUser } from '@/lib/db/ownership';
import { apiHandler } from '@/lib/api/http';
import { requireAdmin } from '@/services/billing/service';
import { registryOverview, recentModelEvents, syncRegistry } from '@/lib/ai/model-registry';
import { aiPolicy, huggingFaceConfigured } from '@/lib/ai/config';

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
  const overview = registryOverview();
  return Response.json({
    overview,
    recentEvents: recentModelEvents({ limit: 25 }),
    recentFailures: recentModelEvents({ limit: 25, onlyFailures: true }),
    configuration: {
      backend: policy.backend,
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
