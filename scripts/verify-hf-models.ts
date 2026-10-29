/**
 * Verify the configured Agnes AI models and regenerate the status reports.
 *
 *   npm run ai:verify                # live smoke checks for text models
 *   npm run ai:verify -- --smoke     # also run smoke for all eligible models
 *   npm run ai:verify -- --task=image
 *   npm run ai:verify -- --model=agnes-2.5-flash --smoke
 *   npm run ai:models:report         # regenerate MODEL_STATUS.md from stored results (no network)
 *
 * Requires AGNES_API_KEY. Image smoke tests additionally require AI_ALLOW_LIVE_IMAGE_HEALTH_CHECKS=true.
 */
import fs from 'node:fs';
import path from 'node:path';
import { closeDb } from '../src/lib/db';
import { agnesConfigured, aiPolicy } from '../src/lib/ai/config';
import { verifyAllModels, verifyModel } from '../src/lib/ai/model-verification';
import { syncRegistry } from '../src/lib/ai/model-registry';
import { buildModelStatusJson, buildModelStatusMarkdown } from '../src/lib/ai/model-report';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const task = (arg('task') as 'text-generation' | 'text-to-image' | undefined) ?? undefined;
  const model = arg('model');
  const smoke = flag('smoke');
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const concurrency = arg('concurrency') ? Number(arg('concurrency')) : 3;

  syncRegistry();

  if (!agnesConfigured()) {
    console.warn('[verify] AGNES_API_KEY is not set — verification will report unconfigured. Set AGNES_API_KEY and re-run.');
  } else {
    const policy = aiPolicy();
    console.log(`[verify] Agnes base=${policy.agnesBaseUrl} smoke=${smoke ? 'yes' : 'no'}`);
  }

  const started = Date.now();
  let results;
  if (model) {
    const single = await verifyModel(model, { smoke, force: true });
    results = [single];
  } else {
    results = await verifyAllModels({
      smoke,
      force: true,
      ...(task ? { task } : {}),
      ...(limit ? { limit } : {}),
      concurrency,
    });
  }

  const available = results.filter(r => r.availability === 'available').length;
  const live = results.filter(r => r.smokeTest?.ok).length;
  const priced = results.filter(r => r.pricing.status === 'paid').length;
  const free = results.filter(r => r.pricing.status === 'free').length;
  const errors = results.filter(r => r.verificationError);

  console.log('');
  console.log('[verify] results');
  console.log(`  models checked : ${results.length}`);
  console.log(`  available      : ${available}`);
  console.log(`  live-tested ok : ${live}`);
  console.log(`  pricing free   : ${free}`);
  console.log(`  pricing paid   : ${priced}`);
  console.log(`  pricing unknown: ${results.length - free - priced}`);
  if (errors.length) console.log(`  check failures : ${errors.length}`);

  for (const r of results) {
    console.log(
      `  · ${r.modelId}: ${r.availability} · ${r.pricing.status}${r.smokeTest?.ran ? ` · smoke=${r.smokeTest.ok ? 'ok' : 'failed'}` : ''}${r.verificationError ? ` · ${r.verificationError}` : ''}`,
    );
  }

  const docsDir = path.join(process.cwd(), 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(
    path.join(docsDir, 'model-status.json'),
    `${JSON.stringify(buildModelStatusJson(agnesConfigured()), null, 2)}\n`,
    'utf8',
  );
  const markdown = buildModelStatusMarkdown(agnesConfigured());
  fs.writeFileSync(path.join(process.cwd(), 'MODEL_STATUS.md'), markdown, 'utf8');
  console.log('');
  console.log(`[verify] wrote docs/model-status.json and MODEL_STATUS.md in ${Math.round((Date.now() - started) / 1000)}s`);

  closeDb();
}

main().catch(err => {
  console.error('[verify] fatal:', err);
  process.exit(1);
});
