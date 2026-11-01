import { beforeEach, expect, it } from 'vitest';
import { freshDatabase, db, seedNovel, seedUser } from '../helpers/db';
import { UniversalGenerationService } from '@/lib/ai/generation/generation-service';

beforeEach(() => freshDatabase());

it('rejects a malformed generation before writing a job', async () => {
  const user = seedUser();
  const novel = seedNovel(user.id);
  await expect(UniversalGenerationService.createJob({
    userId: user.id, projectId: novel.id, generationType: 'rewrite', prompt: '',
  })).rejects.toThrow();
  expect(db().prepare('SELECT COUNT(*) AS count FROM generation_jobs').get()).toEqual({ count: 0 });
});
