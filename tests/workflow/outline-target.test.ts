import { beforeEach, expect, it, vi } from 'vitest';
import { db, freshDatabase, seedNovel, seedUser } from '../helpers/db';

const generate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/text-generation', () => ({ generateStructuredDetailed: generate }));
import { runOutline } from '@/services/outlines/service';

beforeEach(() => {
  freshDatabase();
  generate.mockReset();
});

it('constructs a valid fallback outline using the novel word budget', async () => {
  const user = seedUser();
  const novel = seedNovel(user.id, { targetChapters: 3, targetWords: 60000 });
  generate.mockImplementation(async (_shape, input) => ({
    data: input.fallback,
    meta: { usedFallback: false, source: 'demo', model: 'test' },
  }));

  await runOutline({ userId: user.id, novelId: novel.id });
  const rows = db().prepare('SELECT targetWords, estimatedPages FROM chapter_outlines WHERE novelId = ?').all(novel.id) as { targetWords: number; estimatedPages: number }[];
  expect(rows).toHaveLength(3);
  expect(rows.every(row => row.targetWords === 20000 && row.estimatedPages === 63)).toBe(true);
});
