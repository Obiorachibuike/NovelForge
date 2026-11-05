import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, freshDatabase, seedNovel, seedUser } from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
const createJob = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({
  auth: async () => session.userId ? { user: { id: session.userId } } : null,
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));
vi.mock('@/lib/ai/generation/generation-service', () => ({
  UniversalGenerationService: { createJob },
}));

import { validateGenerationInput } from '@/lib/ai/generation/generation-validation';
import { POST as create } from '@/app/api/generations/create/route';
import { POST as universal } from '@/app/api/generations/universal/route';

function request(body: unknown) {
  return new Request('http://localhost/api/generations/create', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  freshDatabase();
  session.userId = null;
  createJob.mockReset();
});

describe('generation request validation', () => {
  it('requires a project, generation type and nonempty prompt', () => {
    const valid = { projectId: 'novel', generationType: 'rewrite', prompt: 'Rewrite' };
    expect(validateGenerationInput({ ...valid, userId: 'other' }, 'author').userId).toBe('author');
    for (const body of [
      { ...valid, projectId: undefined }, { ...valid, projectId: '' },
      { ...valid, prompt: '' }, { ...valid, generationType: 'unknown' },
    ]) expect(() => validateGenerationInput(body, 'author')).toThrow();
  });

  for (const route of [create, universal]) {
    it('checks session, project and ownership before creating a job', async () => {
      const author = seedUser();
      const other = seedUser();
      const novel = seedNovel(other.id);
      const body = { projectId: novel.id, generationType: 'rewrite', prompt: 'Rewrite', userId: other.id };
      expect((await route(request(body))).status).toBe(401);
      session.userId = author.id;
      expect((await route(request({ ...body, projectId: undefined }))).status).toBe(400);
      expect((await route(request(body))).status).toBe(404);
      expect(createJob).not.toHaveBeenCalled();
      expect(db().prepare('SELECT COUNT(*) AS count FROM generation_jobs').get()).toEqual({ count: 0 });
    });
  }
});
