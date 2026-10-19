import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  freshDatabase,
  db,
  seedUser,
  seedNovel,
  seedOutline,
  seedChapter,
  jsonRequest,
  readJson,
} from '../helpers/db';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth/config', () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: 'Writer', email: 'writer@example.com' } } : null),
  handlers: {}, signIn: async () => {}, signOut: async () => {},
}));

import {
  registerHandler,
  enqueue,
  runJob,
  getJob,
  classifyJobError,
  sanitizeErrorMessage,
  NonRetryableJobError,
} from '@/lib/queue';
import { runChapterGeneration, saveChapterContent } from '@/services/chapters/service';
import { estimateOperationCost } from '@/lib/ai/pricing';
import { recordUsage, novelUsageSummary } from '@/lib/ai/usage';
import { isRetryableProviderError } from '@/lib/ai/text-generation';
import { GET as getJobRoute, POST as postJobRoute, DELETE as deleteJobRoute } from '@/app/api/jobs/[jobId]/route';
import { GET as getUsageRoute } from '@/app/api/usage/route';

describe('AI job lifecycle, cancellation, error classification & cost estimation', () => {
  beforeEach(() => {
    freshDatabase();
    session.userId = null;
  });

  it('classifies permanent vs retryable errors and redacts secrets from job error messages', () => {
    const budgetErr = classifyJobError(
      Object.assign(new Error('Daily AI token budget reached'), { code: 'ai_daily_token_limit' }),
    );
    expect(budgetErr.retryable).toBe(false);
    expect(budgetErr.code).toBe('ai_daily_token_limit');

    const rateLimitErr = classifyJobError(
      Object.assign(new Error('429 Too Many Requests from upstream'), { status: 429 }),
    );
    expect(rateLimitErr.retryable).toBe(true);
    expect(rateLimitErr.code).toBe('rate_limited');

    const sanitized = sanitizeErrorMessage(
      'OpenAI request failed with key sk-proj-1234567890abcdef and Bearer secret_token_xyz at redis://admin:supersecret@cache.internal:6379',
    );
    expect(sanitized).toContain('sk-[REDACTED]');
    expect(sanitized).toContain('Bearer [REDACTED]');
    expect(sanitized).toContain('redis://admin:[REDACTED]@cache.internal:6379');
    expect(sanitized).not.toContain('1234567890abcdef');
    expect(sanitized).not.toContain('supersecret');
  });

  it('does not retry NonRetryableJobError and marks retryable=0 on the job row', async () => {
    const alice = seedUser();
    const novel = seedNovel(alice.id);
    let attempts = 0;

    registerHandler('test_permanent_fail', async () => {
      attempts++;
      throw new NonRetryableJobError('Chapter 1 must be approved first.', 'chapter_sequence_locked');
    });

    const jobId = await enqueue({
      userId: alice.id,
      novelId: novel.id,
      type: 'test_permanent_fail' as any,
      payload: {},
      maxAttempts: 3,
    });
    await runJob(jobId);

    const job = (await getJob(jobId))!;
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(1);
    expect(attempts).toBe(1);
    expect(job.errorCode).toBe('chapter_sequence_locked');
    expect(job.retryable).toBe(0);
  });

  it('supports awaiting_review job status and refuses to overwrite newer user edits if cancelled mid-flight', async () => {
    const alice = seedUser();
    const novel = seedNovel(alice.id);
    seedOutline(novel.id, 1);

    registerHandler('test_review_gate', async () => {
      return { awaitingReview: true, draftId: 'draft_1' };
    });

    const reviewJobId = await enqueue({
      userId: alice.id,
      novelId: novel.id,
      type: 'test_review_gate' as any,
      payload: {},
    });
    await runJob(reviewJobId);
    const reviewJob = (await getJob(reviewJobId))!;
    expect(reviewJob.status).toBe('awaiting_review');

    registerHandler('chapter', runChapterGeneration);

    const jobId = await enqueue({
      userId: alice.id,
      novelId: novel.id,
      type: 'chapter',
      payload: { chapterNumber: 1 },
    });
    await runJob(jobId);

    const job = (await getJob(jobId))!;
    expect(job.status).toBe('completed');

    // Now simulate a user editing Chapter 1 and a mid-flight cancelled regeneration job:
    const chapterRow = db()
      .prepare('SELECT id, revision, generatedContentJson FROM chapters WHERE novelId = ? AND chapterNumber = 1')
      .get(novel.id) as any;
    expect(chapterRow).toBeDefined();
    expect(chapterRow.generatedContentJson).toBeTruthy();

    const userEditedDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Author manually wrote this treasured paragraph.' }] }],
    };
    await saveChapterContent(alice.id, novel.id, chapterRow.id, userEditedDoc);

    // Attempt to run generation where isCancelled() returns true before persistence
    await expect(
      runChapterGeneration({
        id: 'job_cancelled_mid_flight',
        userId: alice.id,
        novelId: novel.id,
        payload: { chapterNumber: 1, confirmOverwrite: true },
        isCancelled: () => true,
      }),
    ).rejects.toThrow(/cancelled/i);

    const afterCancelRow = db()
      .prepare('SELECT plainText FROM chapters WHERE id = ?')
      .get(chapterRow.id) as any;
    expect(afterCancelRow.plainText).toBe('Author manually wrote this treasured paragraph.');
  });

  it('allows owners to cancel and retry jobs via /api/jobs/[jobId] while rejecting other users', async () => {
    const alice = seedUser();
    const bob = seedUser();
    const novel = seedNovel(alice.id);

    let shouldFail = true;
    registerHandler('test_cancel_retry', async () => {
      if (shouldFail) throw new Error('Transient network timeout');
      return { ok: true };
    });

    const queuedJobId = await enqueue({
      userId: alice.id,
      novelId: novel.id,
      type: 'test_cancel_retry' as any,
      payload: {},
    });

    // Bob cannot cancel Alice's job
    session.userId = bob.id;
    const bobCancel = await deleteJobRoute(
      jsonRequest(`/api/jobs/${queuedJobId}`, undefined, { method: 'DELETE' }),
      { params: { jobId: queuedJobId } },
    );
    expect(bobCancel.status).toBe(404);

    // Alice cancels the job
    session.userId = alice.id;
    const aliceCancel = await postJobRoute(
      jsonRequest(`/api/jobs/${queuedJobId}`, { action: 'cancel' }),
      { params: { jobId: queuedJobId } },
    );
    expect(aliceCancel.status).toBe(200);
    const cancelledBody = await readJson(aliceCancel);
    expect(cancelledBody.job.status).toBe('cancelled');

    // Alice retries the cancelled job after transient failure clears
    shouldFail = false;
    const aliceRetry = await postJobRoute(
      jsonRequest(`/api/jobs/${queuedJobId}`, { action: 'retry' }),
      { params: { jobId: queuedJobId } },
    );
    expect(aliceRetry.status).toBe(200);
    await runJob(queuedJobId);

    const finalRes = await getJobRoute(
      jsonRequest(`/api/jobs/${queuedJobId}`),
      { params: { jobId: queuedJobId } },
    );
    const finalJob = await readJson(finalRes);
    expect(finalJob.status).toBe('completed');
  });

  it('computes pre-operation cost estimates and tracks usage per user, novel, chapter, and job', async () => {
    const alice = seedUser();
    const novel = seedNovel(alice.id);
    seedOutline(novel.id, 1);
    const ch1 = seedChapter(novel.id, { chapterNumber: 1 });

    const est = estimateOperationCost({ taskType: 'chapter', targetWords: 3000 });
    expect(est.estimatedPromptTokens).toBeGreaterThan(1000);
    expect(est.estimatedCompletionTokens).toBeGreaterThan(3000);
    expect(est.estimatedCostUsd).toBeGreaterThan(0);

    recordUsage({
      userId: alice.id,
      novelId: novel.id,
      chapterId: ch1,
      provider: 'openai',
      model: est.model,
      taskType: 'chapter',
      promptTokens: 1800,
      completionTokens: 3200,
      estimatedCostBeforeUsd: est.estimatedCostUsd,
    });

    const summary = novelUsageSummary(alice.id, novel.id);
    expect(summary.totalTokens).toBe(5000);
    expect(summary.requests).toBe(1);
    expect(summary.byChapter[0]?.chapterId).toBe(ch1);

    session.userId = alice.id;
    const usageRes = await getUsageRoute(
      jsonRequest(`/api/usage?novelId=${novel.id}&estimateTask=chapter&targetWords=2500`),
    );
    expect(usageRes.status).toBe(200);
    const body = await readJson(usageRes);
    expect(body.novelUsage.totalTokens).toBe(5000);
    expect(body.estimate.taskType).toBe('chapter');
    expect(body.estimate.providerCostUsd).toBeGreaterThan(0);

    expect(isRetryableProviderError({ status: 429 })).toBe(true);
    expect(isRetryableProviderError({ status: 503 })).toBe(true);
    expect(isRetryableProviderError({ status: 400 })).toBe(false);
    expect(isRetryableProviderError({ status: 401 })).toBe(false);
  });
});
