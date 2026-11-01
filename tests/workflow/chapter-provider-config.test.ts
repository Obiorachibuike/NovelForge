import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, freshDatabase, seedNovel, seedOutline, seedUser } from '../helpers/db';
import { enqueueChapterGeneration } from '@/services/chapters/service';

let userId: string;
let novelId: string;

beforeEach(() => {
  // Exercise the real enqueue gate, but never dispatch a job or contact AI.
  for (const name of ['AGNES_API_KEY', 'HF_TOKEN', 'HUGGINGFACEHUB_API_TOKEN', 'OPENAI_API_KEY', 'AI_BACKEND', 'AI_PROVIDER', 'REDIS_URL']) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('AI_DEMO_MODE', 'false');
  vi.stubEnv('QUEUE_NO_INPROCESS', '1');
  vi.stubEnv('QUEUE_PROVIDER', 'inprocess');
  freshDatabase();
  userId = seedUser().id;
  novelId = seedNovel(userId).id;
  seedOutline(novelId, 1);
});
afterEach(() => vi.unstubAllEnvs());

function expectNoWork() {
  expect(db().prepare('SELECT COUNT(*) AS c FROM generation_jobs').get()).toEqual({ c: 0 });
  expect(db().prepare('SELECT COUNT(*) AS c FROM chapters').get()).toEqual({ c: 0 });
}

describe('chapter provider configuration errors', () => {
  it.each(['AGNES_API_KEY', 'HF_TOKEN', 'OPENAI_API_KEY'])(
    'reports the demo override, not a missing key, when %s is configured', async key => {
      vi.stubEnv(key, key === 'HF_TOKEN' ? 'hf_test-credential' : 'test-credential');
      vi.stubEnv('AI_DEMO_MODE', 'true');
      await expect(enqueueChapterGeneration(userId, novelId, 1)).rejects.toMatchObject({
        code: 'text_provider_unavailable',
        message: expect.stringContaining('disabled because AI_DEMO_MODE=true'),
      });
      expectNoWork();
    },
  );

  it.each(['AGNES_API_KEY', 'HF_TOKEN', 'OPENAI_API_KEY'])(
    'accepts %s with demo mode disabled without requiring another provider', async key => {
      vi.stubEnv(key, key === 'HF_TOKEN' ? 'hf_test-credential' : 'test-credential');
      const jobId = await enqueueChapterGeneration(userId, novelId, 1);
      expect(db().prepare('SELECT status FROM generation_jobs WHERE id=?').get(jobId)).toEqual({ status: 'queued' });
    },
  );

  it('explains deployment scope and redeployment when no keys are present', async () => {
    await expect(enqueueChapterGeneration(userId, novelId, 1)).rejects.toMatchObject({
      code: 'text_provider_unavailable',
      message: expect.stringContaining('Production or Preview'),
    });
    expectNoWork();
  });

  it('does not mistake a placeholder key for a configured provider', async () => {
    vi.stubEnv('AGNES_API_KEY', 'agnes_your_key');
    await expect(enqueueChapterGeneration(userId, novelId, 1)).rejects.toMatchObject({
      message: expect.stringContaining('cannot find a usable AI provider key'),
    });
    expectNoWork();
  });
});
