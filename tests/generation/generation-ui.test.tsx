// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGenerationStream } from '@/lib/hooks/useGenerationStream';
import { generationStatusLabel } from '@/components/generation/GenerationStatusBadge';

type Listener = (event: { data: string }) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }

  close() {
    this.closed = true;
  }
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    novelId: 'novel-1',
    chapterNumber: 2,
    status: 'PROCESSING',
    currentStage: 'GENERATING_CHAPTER_CONTENT',
    currentStageLabel: 'Generating chapter content',
    progressPercentage: null,
    ...overrides,
  };
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('global generation stream (client)', () => {
  it('tracks real stages, fires the terminal callback once, and never cancels on unmount', () => {
    const onUpdate = vi.fn();
    const onTerminal = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { result, unmount } = renderHook(() =>
      useGenerationStream('job-1', { onUpdate, onTerminal }),
    );

    const source = MockEventSource.instances[0];
    expect(source.url).toBe('/api/generations/job-1/events');

    act(() => source.onopen?.());
    expect(result.current.connected).toBe(true);

    act(() => source.emit('generation_snapshot', job({ status: 'QUEUED' })));
    act(() =>
      source.emit(
        'generation_progress',
        job({ currentStage: 'SAVING_CHAPTER', currentStageLabel: 'Saving chapter' }),
      ),
    );
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(result.current.generation?.currentStageLabel).toBe('Saving chapter');
    expect(result.current.generation?.progressPercentage).toBeNull();

    act(() => source.emit('generation_completed', job({ status: 'COMPLETED', chapterId: 'chapter-2' })));
    act(() => source.emit('generation_completed', job({ status: 'COMPLETED', chapterId: 'chapter-2' })));
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(result.current.generation?.status).toBe('COMPLETED');

    // Navigation/unmount closes only the local notification channel.
    unmount();
    expect(source.closed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('clears retry provenance and applies models reported during a multi-step job', () => {
    const { result } = renderHook(() => useGenerationStream('job-1'));
    const source = MockEventSource.instances[0];
    act(() => source.emit('generation_snapshot', job({ requestedModel: 'auto', actualModel: 'old-model', provider: 'together', fallbackCount: 1,
      modelUsages: [{ actualModel: 'old-model', provider: 'together' }] })));
    act(() => source.emit('generation_queued', job({ status: 'QUEUED', actualModel: null, provider: null, fallbackCount: 0, modelUsages: null })));
    expect(result.current.generation).toMatchObject({ status: 'QUEUED', requestedModel: 'auto', actualModel: null, provider: null, fallbackCount: 0, modelUsages: null });
    act(() => source.emit('generation_progress', job({ modelUsages: [{ actualModel: 'new-model', provider: 'agnes-ai', fallbackUsed: false }] })));
    expect(result.current.generation?.modelUsages).toEqual([{ actualModel: 'new-model', provider: 'agnes-ai', fallbackUsed: false }]);
  });

  it('deduplicates snapshot replay and replaces, rather than appends, a new attempt', () => {
    const { result } = renderHook(() => useGenerationStream('job-1'));
    const source = MockEventSource.instances[0];
    act(() => source.emit('generation_snapshot', job({ partialText: 'First draft', partialSequence: 5 })));
    act(() => source.emit('generation_content', { sequence: 4, delta: 'First ', status: 'PROCESSING' }));
    act(() => source.emit('generation_content', { sequence: 5, delta: 'draft', status: 'PROCESSING' }));
    expect(result.current.generation?.partialText).toBe('First draft');

    act(() => source.emit('generation_queued', job({ status: 'QUEUED', partialText: 'First draft', partialSequence: 5 })));
    act(() => source.emit('generation_content', { sequence: 12, delta: 'Fresh ', replace: true, status: 'PROCESSING' }));
    act(() => source.emit('generation_content', { sequence: 13, delta: 'answer', status: 'PROCESSING' }));
    expect(result.current.generation?.partialText).toBe('Fresh answer');

    // Reconnection sends the current snapshot before replaying old events.
    act(() => source.emit('generation_snapshot', job({ partialText: 'Fresh answer', partialSequence: 13 })));
    act(() => source.emit('generation_content', { sequence: 12, delta: 'Fresh ', replace: true, status: 'PROCESSING' }));
    act(() => source.emit('generation_content', { sequence: 13, delta: 'answer', status: 'PROCESSING' }));
    expect(result.current.generation?.partialText).toBe('Fresh answer');

    // Final provider validation can shorten the answer (e.g. deduplication).
    act(() => source.emit('generation_completed', job({ status: 'COMPLETED', partialText: 'Fresh', partialSequence: 13, actualModel: 'actual-model' })));
    expect(result.current.generation).toMatchObject({ partialText: 'Fresh', actualModel: 'actual-model' });
  });

  it('reconnects through a new EventSource and reports disconnects without failing the job', () => {
    const onUpdate = vi.fn();
    const first = renderHook(() => useGenerationStream('job-1', { onUpdate }));
    const source = MockEventSource.instances[0];

    act(() => source.onopen?.());
    expect(first.result.current.connected).toBe(true);
    act(() => source.onerror?.());
    expect(first.result.current.connected).toBe(false);

    first.unmount();
    // The provider re-subscribes after a refresh: a fresh hook opens a fresh
    // EventSource, and the server replays missed events from Last-Event-ID.
    const second = renderHook(() => useGenerationStream('job-1', { onUpdate }));
    expect(MockEventSource.instances).toHaveLength(2);
    act(() => MockEventSource.instances[1].emit('generation_completed', job({ status: 'COMPLETED' })));
    expect(second.result.current.generation?.status).toBe('COMPLETED');
  });

  it('gives up after repeated connection failures instead of retrying forever', () => {
    renderHook(() => useGenerationStream('job-1'));
    const source = MockEventSource.instances[0];
    act(() => {
      for (let i = 0; i < 10; i += 1) source.onerror?.();
    });
    expect(source.closed).toBe(true);
  });

  it('labels every public lifecycle status', () => {
    expect(generationStatusLabel('QUEUED')).toBe('QUEUED');
    expect(generationStatusLabel('PROCESSING')).toBe('IN PROGRESS');
    expect(generationStatusLabel('COMPLETED')).toBe('COMPLETED');
    expect(generationStatusLabel('FAILED')).toBe('FAILED');
    expect(generationStatusLabel('CANCELLED')).toBe('CANCELLED');
    expect(generationStatusLabel(null)).toBe('NOT STARTED');
  });
});
