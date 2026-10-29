/**
 * Regenerate MODEL_STATUS.md and docs/model-status.json from stored verification
 * results. Makes no network calls.
 *
 *   npm run ai:models:report
 */
import fs from 'node:fs';
import path from 'node:path';
import { closeDb } from '../src/lib/db';
import { agnesConfigured } from '../src/lib/ai/config';
import { buildModelStatusJson, buildModelStatusMarkdown } from '../src/lib/ai/model-report';

const docsDir = path.join(process.cwd(), 'docs');
fs.mkdirSync(docsDir, { recursive: true });
fs.writeFileSync(
  path.join(docsDir, 'model-status.json'),
  `${JSON.stringify(buildModelStatusJson(agnesConfigured()), null, 2)}\n`,
  'utf8',
);
fs.writeFileSync(path.join(process.cwd(), 'MODEL_STATUS.md'), buildModelStatusMarkdown(agnesConfigured()), 'utf8');
console.log('[report] wrote MODEL_STATUS.md and docs/model-status.json');
closeDb();
