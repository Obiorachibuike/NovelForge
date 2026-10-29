import { requireUser } from '@/lib/db/ownership';
import { apiHandler, readJsonBody } from '@/lib/api/http';
import { requireAdmin } from '@/services/billing/service';
import { aiProviderSummary } from '@/lib/ai/config';
import { testAgnesProvider } from '@/lib/ai/provider-diagnostics';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  provider: z.literal('agnes').default('agnes'),
  /** `text` is a few tokens; `image` is opt-in and needs a policy flag. */
  kind: z.enum(['text', 'image']).default('text'),
});

/**
 * Administrator-only live provider test.
 *
 * Proves that the credential in *this* deployment works end to end, which an
 * environment-variable listing cannot: a variable scoped to the wrong
 * environment, a revoked key, or a deployment built before the variable was
 * added all look identical from the dashboard. The response never contains the
 * key — only the model, latency and a short proof-of-life excerpt.
 */
export const POST = apiHandler(async (req: Request) => {
  const user = await requireUser();
  requireAdmin(user.id);

  const body = await readJsonBody(req, v => bodySchema.parse(v ?? {}));
  const result = await testAgnesProvider(body.kind);

  console.info(
    `[admin/ai] Agnes ${body.kind} test by ${user.id}: ${result.ok ? 'ok' : `failed (${result.error?.category})`}` +
      ` model=${result.model} latency=${result.latencyMs}ms`,
  );

  const summary = aiProviderSummary();
  return Response.json(
    {
      ...result,
      // Whether the running deployment still considers Agnes the live backend.
      backend: summary.backend,
      configured: summary.providers.find(p => p.name === 'agnes')?.configured ?? false,
    },
    { status: result.ok ? 200 : 502, headers: { 'Cache-Control': 'no-store' } },
  );
});
