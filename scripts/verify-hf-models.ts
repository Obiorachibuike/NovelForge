/**
 * Verify the configured Hugging Face models and regenerate the status reports.
 *
 *   npm run ai:verify                # repository + provider-mapping checks (cheap, no inference)
 *   npm run ai:verify -- --smoke     # also run a tiny live inference per eligible text model
 *   npm run ai:verify -- --task=image
 *   npm run ai:verify -- --model=Qwen/Qwen2.5-7B-Instruct --smoke
 *   npm run ai:models:report         # regenerate MODEL_STATUS.md from stored results (no network)
 *
 * Requires HF_TOKEN (a fine-grained token with "Make calls to Inference
 * Providers") and a reachable https://huggingface.co / https://router.huggingface.co.
 * Image smoke tests additionally require AI_ALLOW_LIVE_IMAGE_HEALTH_CHECKS=true
 * because they spend provider credits.
 */
import fs from 'node:fs';
import path from 'node:path';
import { closeDb } from '../src/lib/db';
import { aiPolicy, huggingFaceConfigured } from '../src/lib/ai/config';
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

  if (!huggingFaceConfigured()) {
    console.warn('[verify] HF_TOKEN is not set — nothing will be verified. Set HF_TOKEN and re-run.');
  } else {
    const policy = aiPolicy();
    console.log(`[verify] router=${policy.routerBaseUrl} hub=${policy.hubApiBaseUrl} smoke=${smoke ? 'yes' : 'no'}`);
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
  if (errors.length) console.log(`  check failures : ${errors.length} (network/auth problems, not model verdicts)`);

  for (const r of results) {
    console.log(
      `  · ${r.modelId}: ${r.availability} · ${r.pricing.status} · repo=${r.repository.exists ? 'yes' : 'no'}${
        r.smokeTest?.ran ? ` · smoke=${r.smokeTest.ok ? 'ok' : 'failed'}` : ''
      }${r.verificationError ? ` · ${r.verificationError}` : ''}`,
    );
  }

  // Persist machine-readable + Markdown reports.
  const docsDir = path.join(process.cwd(), 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(
    path.join(docsDir, 'model-status.json'),
    `${JSON.stringify(buildModelStatusJson(huggingFaceConfigured()), null, 2)}\n`,
    'utf8',
  );
  const markdown = buildModelStatusMarkdown(huggingFaceConfigured());
  fs.writeFileSync(path.join(process.cwd(), 'MODEL_STATUS.md'), markdown, 'utf8');
  console.log('');
  console.log(`[verify] wrote docs/model-status.json and MODEL_STATUS.md in ${Math.round((Date.now() - started) / 1000)}s`);

  closeDb();
}

main().catch(err => {
  console.error('[verify] fatal:', err);
  process.exit(1);
});
