// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelIndicator } from '@/components/ai/ModelIndicator';
import CoverStudio from '@/components/visuals/CoverStudio';
import PreparationWorkspace from '@/components/story-bible/PreparationWorkspace';
import OutlineEditor from '@/components/outline/OutlineEditor';
import ConsistencyView from '@/components/consistency/ConsistencyView';
import { GenerationDock } from '@/components/generation/GenerationDock';
import { GenerationContext } from '@/components/generation/GenerationContext';
import { useJobWatcher } from '@/lib/hooks/useJobWatcher';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }));
vi.mock('@/components/ai/ModelSelector', () => ({ default: () => <div>Model selection</div> }));

function withQuery(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('model indication', () => {
  it('does not present an automatic or requested model as the actual result while pending', () => {
    const { rerender } = render(<ModelIndicator status="processing" requestedModel="auto" />);
    expect(screen.getByText(/Requested model: Automatic/)).toBeTruthy();
    expect(screen.queryByText(/Model used:/)).toBeNull();
    rerender(<ModelIndicator status="queued" requestedModel="agnes-2.5-flash" />);
    expect(screen.getByText(/Requested model: Agnes 2.5 Flash/)).toBeTruthy();
  });

  it('shows the real model, provider and fallback without hiding repository ownership', () => {
    render(<ModelIndicator status="completed" requestedModel="Qwen/Qwen2.5-7B-Instruct" actualModel="other/Qwen2.5-7B-Instruct" provider="together" fallbackUsed />);
    const label = screen.getByText('Model used: other/Qwen2.5-7B-Instruct · Together AI (fallback)');
    expect(label.parentElement?.getAttribute('title')).toContain('Requested: Qwen/Qwen2.5-7B-Instruct');
  });

  it('does not mistake a provider-reported version for a fallback', () => {
    render(<ModelIndicator status="completed" requestedModel="gpt-4o" actualModel="gpt-4o-2024-08-06" provider="openai" />);
    expect(screen.getByText('Model used: gpt-4o-2024-08-06 · OpenAI')).toBeTruthy();
    expect(screen.queryByText(/fallback/)).toBeNull();
  });

  it('never labels demo, placeholder or old unknown content as AI-generated', () => {
    const { rerender } = render(<ModelIndicator provider="demo" actualModel="gpt-4o-mini" />);
    expect(screen.getByText('Demo output · no AI model')).toBeTruthy();
    expect(screen.queryByText(/gpt-4o-mini/)).toBeNull();
    rerender(<ModelIndicator provider="svg-fallback" actualModel="agnes-image-2.5-flash" />);
    expect(screen.getByText('Placeholder output · no AI model')).toBeTruthy();
    rerender(<ModelIndicator status="completed" />);
    expect(screen.getByText('Model used: Not recorded')).toBeTruthy();
  });

  it('lists all models in a multi-chapter consistency check and identifies a skipped check', () => {
    const { rerender } = render(<ModelIndicator status="completed" modelUsages={[
      { actualModel: 'agnes-2.5-flash', provider: 'agnes-ai' },
      { actualModel: 'Qwen/Qwen2.5-7B-Instruct', provider: 'together', fallbackUsed: true },
      { actualModel: null, provider: 'fallback' },
    ]} />);
    expect(screen.getByText('Model used: Agnes 2.5 Flash · Agnes AI')).toBeTruthy();
    expect(screen.getByText('Model used: Qwen/Qwen2.5-7B-Instruct · Together AI (fallback)')).toBeTruthy();
    expect(screen.getByText('Placeholder output · no AI model')).toBeTruthy();
    rerender(<ModelIndicator status="completed" modelUsages={[]} />);
    expect(screen.getByText('No AI model was used.')).toBeTruthy();
  });

  it('displays stored image model IDs, restored fallback metadata, and demo covers', () => {
    const covers = [
      { id: 'a', url: '/a.png', provider: 'agnes-ai', model: 'agnes-image-2.5-flash', requestedModel: 'auto', createdAt: '2026-01-01' },
      { id: 'b', url: '/b.png', provider: 'together', model: 'black-forest-labs/FLUX.1-schnell', requestedModel: 'auto', meta: '{"modelFallbackUsed":true}', createdAt: '2026-01-01' },
      { id: 'c', url: '/c.png', provider: 'demo-svg', model: null, createdAt: '2026-01-01' },
      { id: 'd', url: '/d.png', provider: 'openai', model: 'gpt-image-1', createdAt: '2026-01-01' },
    ];
    render(withQuery(<CoverStudio novel={{ id: 'novel', title: 'Test' }} initialCovers={covers} />));
    expect(screen.getByText('Model used: Agnes Image 2.5 Flash · Agnes AI')).toBeTruthy();
    expect(screen.getByText('Model used: black-forest-labs/FLUX.1-schnell · Together AI (fallback)')).toBeTruthy();
    expect(screen.getByText('Demo output · no AI model')).toBeTruthy();
    expect(screen.getByText('Model used: gpt-image-1 · OpenAI')).toBeTruthy();
  });

  it('restores the model used by preparation, outline and consistency jobs', () => {
    const job = { id: 'job', status: 'completed', requestedModel: 'auto', actualModel: 'agnes-2.5-flash', provider: 'agnes-ai', fallbackCount: 0 };
    const { unmount } = render(withQuery(<PreparationWorkspace novel={{ id: 'novel' }} premise={{ logline: 'A story' }} characters={[]} worldRules={[]} initialJob={job} />));
    expect(screen.getByText('Model used: Agnes 2.5 Flash · Agnes AI')).toBeTruthy();
    unmount();
    const outline = render(withQuery(<OutlineEditor novel={{ id: 'novel' }} outlines={[]} acts={[]} chapters={[]} navigation={[]} initialJob={job} />));
    expect(screen.getByText('Model used: Agnes 2.5 Flash · Agnes AI')).toBeTruthy();
    outline.unmount();
    render(withQuery(<ConsistencyView novel={{ id: 'novel' }} score={100} issues={[]} chapterCount={1} approvedCount={1} issueCount={0} initialJob={job} />));
    expect(screen.getByText('Model used: Agnes 2.5 Flash · Agnes AI')).toBeTruthy();
  });

  it('shows the model in the global generation activity panel', () => {
    const job = { id: '1', novelId: 'n', taskType: 'image', status: 'COMPLETED' as const, requestedModel: 'auto', actualModel: 'agnes-image-2.5-flash', provider: 'agnes-ai' };
    const noop = vi.fn(async () => {});
    render(<GenerationContext.Provider value={{ generations: [job], activeGenerations: [], notifications: [], unreadCount: 0, connectedJobIds: [], trackGeneration: vi.fn(), refresh: noop, cancelGeneration: noop, retryGeneration: noop, deleteGeneration: noop, markNotificationRead: noop, markAllNotificationsRead: noop }}><GenerationDock /></GenerationContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open the AI generation activity panel' }));
    expect(screen.getByText('Model used: Agnes Image 2.5 Flash · Agnes AI')).toBeTruthy();
  });

  it('resumes an active restored job and ignores stale responses after switching jobs', async () => {
    const pending = new Map<string, (value: unknown) => void>();
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise(resolve => pending.set(url, resolve))));
    const onComplete = vi.fn();
    const onFail = vi.fn();
    const { result } = renderHook(() => useJobWatcher({ initialJob: { id: 'old', status: 'processing', requestedModel: 'auto' }, onComplete, onFail }));
    expect(result.current.job?.id).toBe('old');
    expect(pending.has('/api/jobs/old')).toBe(true);
    act(() => result.current.watch('new', { requestedModel: 'chosen' }));
    await act(async () => pending.get('/api/jobs/new')!({ ok: true, json: async () => ({ id: 'new', status: 'completed', actualModel: 'new-model' }) }));
    await act(async () => pending.get('/api/jobs/old')!({ ok: true, json: async () => ({ id: 'old', status: 'failed', actualModel: 'old-model' }) }));
    expect(result.current.job).toMatchObject({ id: 'new', status: 'completed', actualModel: 'new-model' });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('does not update or invoke callbacks after the watcher unmounts', async () => {
    let resolve: (value: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise(r => { resolve = r; })));
    const onComplete = vi.fn();
    const { result, unmount } = renderHook(() => useJobWatcher({ onComplete }));
    act(() => result.current.watch('job'));
    unmount();
    await act(async () => resolve({ ok: true, json: async () => ({ id: 'job', status: 'completed' }) }));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('shows a new request immediately and replaces it with actual provenance when polled', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveFetch = resolve; })));
    const { result } = renderHook(() => useJobWatcher());
    act(() => result.current.watch('new-job', { requestedModel: 'agnes-2.5-flash' }));
    expect(result.current.job?.status).toBe('queued');
    expect(result.current.job?.requestedModel).toBe('agnes-2.5-flash');
    await act(async () => resolveFetch({ ok: true, json: async () => ({ id: 'new-job', status: 'completed', requestedModel: 'agnes-2.5-flash', actualModel: 'Qwen/Qwen2.5-7B-Instruct', provider: 'together', fallbackCount: 1 }) }));
    await waitFor(() => expect(result.current.job?.actualModel).toBe('Qwen/Qwen2.5-7B-Instruct'));
    expect(result.current.job?.fallbackCount).toBe(1);
  });
});
