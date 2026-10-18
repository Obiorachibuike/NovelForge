import { countWords } from '@/types';

export const DRAFT_STORAGE_PREFIX = 'novelforge:draft:';
export const MAX_RECOVERY_ENTRIES = 20;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key?(index: number): string | null;
  length?: number;
}

export interface DraftRecoveryEntry {
  novelId: string;
  chapterId: string;
  chapterNumber: number;
  contentJson: { type: 'doc'; content: any[] };
  plainText: string;
  wordCount: number;
  baseRevision: number;
  savedAt: string;
  reason: 'unsaved' | 'save_failed' | 'conflict';
}

export function draftStorageKey(novelId: string, chapterId: string): string {
  return `${DRAFT_STORAGE_PREFIX}${novelId}:${chapterId}`;
}

function getBrowserStorage(explicit?: StorageLike | null): StorageLike | null {
  if (explicit !== undefined) return explicit;
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  return null;
}

export function extractPlainTextFromDoc(doc: any): string {
  if (!doc || doc.type !== 'doc') return '';
  const out: string[] = [];
  const walk = (node: any) => {
    if (node.type === 'text') out.push(node.text || '');
    if (Array.isArray(node.content)) {
      for (const c of node.content) walk(c);
      if (node.type === 'paragraph' || node.type === 'heading') out.push('\n\n');
    }
  };
  walk(doc);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Persists a supplementary recovery draft in browser storage and enforces a
 * bounded retention cap across stored drafts.
 */
export function saveLocalDraft(
  entry: Omit<DraftRecoveryEntry, 'plainText' | 'wordCount' | 'savedAt'> & { savedAt?: string },
  storage?: StorageLike | null,
): DraftRecoveryEntry | null {
  const store = getBrowserStorage(storage);
  if (!store) return null;

  const plainText = extractPlainTextFromDoc(entry.contentJson);
  const full: DraftRecoveryEntry = {
    ...entry,
    plainText,
    wordCount: countWords(plainText),
    savedAt: entry.savedAt || new Date().toISOString(),
  };

  try {
    const key = draftStorageKey(entry.novelId, entry.chapterId);
    store.setItem(key, JSON.stringify(full));
    pruneDraftStorage(store);
    return full;
  } catch {
    return null;
  }
}

export function loadLocalDraft(
  novelId: string,
  chapterId: string,
  storage?: StorageLike | null,
): DraftRecoveryEntry | null {
  const store = getBrowserStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(draftStorageKey(novelId, chapterId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraftRecoveryEntry;
    if (!parsed || parsed.novelId !== novelId || parsed.chapterId !== chapterId || !parsed.contentJson) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearLocalDraft(
  novelId: string,
  chapterId: string,
  storage?: StorageLike | null,
): void {
  const store = getBrowserStorage(storage);
  if (!store) return;
  try {
    store.removeItem(draftStorageKey(novelId, chapterId));
  } catch {
    // ignore storage removal errors
  }
}

/**
 * Returns true when a stored local draft exists and its content differs from
 * the authoritative server chapter content.
 */
export function hasRecoverableDraft(
  localDraft: DraftRecoveryEntry | null | undefined,
  serverContentJson: string | Record<string, unknown> | null | undefined,
): boolean {
  if (!localDraft?.contentJson) return false;
  const localSerialized = JSON.stringify(localDraft.contentJson);
  const serverSerialized = typeof serverContentJson === 'string'
    ? serverContentJson
    : serverContentJson
      ? JSON.stringify(serverContentJson)
      : '';
  if (localSerialized === serverSerialized) return false;
  // Do not offer to recover an empty document over existing server text.
  if (localDraft.wordCount === 0 && serverSerialized.length > 40) return false;
  return true;
}

/**
 * Lists any chapters in a novel that currently have unsaved local drafts.
 */
export function listUnsavedDraftsForNovel(
  novelId: string,
  storage?: StorageLike | null,
): DraftRecoveryEntry[] {
  const store = getBrowserStorage(storage);
  if (!store || typeof store.length !== 'number' || typeof store.key !== 'function') return [];
  const prefix = `${DRAFT_STORAGE_PREFIX}${novelId}:`;
  const entries: DraftRecoveryEntry[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith(prefix)) {
      try {
        const raw = store.getItem(k);
        if (raw) {
          const parsed = JSON.parse(raw) as DraftRecoveryEntry;
          if (parsed?.novelId === novelId) entries.push(parsed);
        }
      } catch {
        // ignore malformed entry
      }
    }
  }
  return entries.sort((a, b) => a.chapterNumber - b.chapterNumber);
}

function pruneDraftStorage(store: StorageLike) {
  if (typeof store.length !== 'number' || typeof store.key !== 'function') return;
  const items: Array<{ key: string; savedAt: string }> = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith(DRAFT_STORAGE_PREFIX)) {
      try {
        const raw = store.getItem(k);
        const parsed = raw ? JSON.parse(raw) : null;
        items.push({ key: k, savedAt: parsed?.savedAt || '' });
      } catch {
        items.push({ key: k, savedAt: '' });
      }
    }
  }
  if (items.length <= MAX_RECOVERY_ENTRIES) return;
  items.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  for (const stale of items.slice(MAX_RECOVERY_ENTRIES)) {
    store.removeItem(stale.key);
  }
}

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';

export interface SaveTransportInput {
  contentJson: { type: 'doc'; content: any[] };
  expectedRevision: number;
  createSnapshot?: boolean;
  snapshotNote?: string;
  signal?: AbortSignal;
}

export interface SaveTransportResult {
  wordCount: number;
  pages: number;
  revision: number;
  updatedAt?: string;
  unchanged?: boolean;
}

export interface AutosaveControllerOptions {
  novelId: string;
  chapterId: string;
  chapterNumber: number;
  initialContentJson: { type: 'doc'; content: any[] };
  initialRevision?: number;
  initialUpdatedAt?: string | null;
  delayMs?: number;
  maxRetries?: number;
  baseRetryMs?: number;
  storage?: StorageLike | null;
  transport: (input: SaveTransportInput) => Promise<SaveTransportResult>;
  onStateChange?: (state: AutosaveState) => void;
}

export interface AutosaveState {
  status: SaveStatus;
  revision: number;
  lastSavedAt: string | null;
  errorMessage: string | null;
  retryCount: number;
  conflictRevision?: number;
}

/**
 * Coordinates debounced autosave, manual save, bounded exponential backoff
 * retries, out-of-order response rejection, and local draft recovery.
 */
export function createAutosaveController(options: AutosaveControllerOptions) {
  const delayMs = options.delayMs ?? 1200;
  const maxRetries = options.maxRetries ?? 3;
  const baseRetryMs = options.baseRetryMs ?? 600;

  let currentDoc = options.initialContentJson;
  let lastSavedSerialized = JSON.stringify(options.initialContentJson);
  let editSeq = 0;
  let lastSavedSeq = 0;
  let inFlightAbort: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  let state: AutosaveState = {
    status: 'saved',
    revision: options.initialRevision ?? 1,
    lastSavedAt: options.initialUpdatedAt ?? null,
    errorMessage: null,
    retryCount: 0,
  };

  const emit = (patch: Partial<AutosaveState>) => {
    state = { ...state, ...patch };
    options.onStateChange?.(state);
  };

  const clearTimers = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const executeSave = async (opts: { createSnapshot?: boolean; snapshotNote?: string; retryAttempt?: number } = {}): Promise<SaveTransportResult | null> => {
    if (disposed) return null;
    const targetDoc = currentDoc;
    const serialized = JSON.stringify(targetDoc);
    const targetSeq = editSeq;

    // Skip redundant writes when content hasn't changed and no manual snapshot is requested.
    if (serialized === lastSavedSerialized && !opts.createSnapshot && state.status !== 'error') {
      if (state.status !== 'saved') emit({ status: 'saved', errorMessage: null, retryCount: 0 });
      return null;
    }

    if (inFlightAbort) {
      inFlightAbort.abort();
    }
    const controller = new AbortController();
    inFlightAbort = controller;

    emit({ status: 'saving', errorMessage: null, retryCount: opts.retryAttempt ?? 0 });

    try {
      const result = await options.transport({
        contentJson: targetDoc,
        expectedRevision: state.revision,
        createSnapshot: opts.createSnapshot,
        snapshotNote: opts.snapshotNote,
        signal: controller.signal,
      });

      if (disposed) return null;

      // Advance revision from server response.
      const nextRevision = result.revision ?? state.revision;
      const savedAt = result.updatedAt || new Date().toISOString();

      // If newer edits occurred while this request was in flight, do not mark
      // the editor as 'saved' or overwrite the newer local draft!
      if (editSeq > targetSeq) {
        lastSavedSerialized = serialized;
        lastSavedSeq = targetSeq;
        emit({ revision: nextRevision, lastSavedAt: savedAt, status: 'unsaved', retryCount: 0 });
        return result;
      }

      lastSavedSerialized = serialized;
      lastSavedSeq = targetSeq;
      clearLocalDraft(options.novelId, options.chapterId, options.storage);
      emit({
        status: 'saved',
        revision: nextRevision,
        lastSavedAt: savedAt,
        errorMessage: null,
        retryCount: 0,
        conflictRevision: undefined,
      });
      return result;
    } catch (err: any) {
      if (disposed || controller.signal.aborted) return null;
      // Ignore failures from obsolete requests if a newer edit already superseded them.
      if (editSeq > targetSeq && err?.code !== 'revision_conflict') {
        return null;
      }

      const code = err?.code;
      const message = err?.message || 'Save failed';

      if (code === 'revision_conflict') {
        saveLocalDraft({
          novelId: options.novelId,
          chapterId: options.chapterId,
          chapterNumber: options.chapterNumber,
          contentJson: targetDoc,
          baseRevision: state.revision,
          reason: 'conflict',
        }, options.storage);
        emit({
          status: 'conflict',
          errorMessage: message,
          conflictRevision: err?.currentRevision,
          retryCount: 0,
        });
        return null;
      }

      // Preserve unsaved content locally whenever a save fails.
      saveLocalDraft({
        novelId: options.novelId,
        chapterId: options.chapterId,
        chapterNumber: options.chapterNumber,
        contentJson: targetDoc,
        baseRevision: state.revision,
        reason: 'save_failed',
      }, options.storage);

      const attempt = (opts.retryAttempt ?? 0) + 1;
      const isPermanent = code === 'chapter_approved' || code === 'payload_too_large' || code === 'validation_failed' || err?.status === 401 || err?.status === 403 || err?.status === 404;

      if (!isPermanent && attempt <= maxRetries) {
        const backoff = Math.min(10_000, baseRetryMs * 2 ** (attempt - 1));
        emit({ status: 'error', errorMessage: `${message} (retrying ${attempt}/${maxRetries}…)`, retryCount: attempt });
        retryTimer = setTimeout(() => {
          void executeSave({ ...opts, retryAttempt: attempt });
        }, backoff);
      } else {
        emit({ status: 'error', errorMessage: message, retryCount: attempt - 1 });
      }
      return null;
    }
  };

  const notifyEdit = (nextDoc: { type: 'doc'; content: any[] }) => {
    if (disposed) return;
    const serialized = JSON.stringify(nextDoc);
    currentDoc = nextDoc;

    // Avoid marking unsaved or scheduling a write if content did not actually change.
    if (serialized === lastSavedSerialized && state.status === 'saved') {
      return;
    }

    editSeq++;
    saveLocalDraft({
      novelId: options.novelId,
      chapterId: options.chapterId,
      chapterNumber: options.chapterNumber,
      contentJson: nextDoc,
      baseRevision: state.revision,
      reason: 'unsaved',
    }, options.storage);

    emit({ status: 'unsaved', errorMessage: null });

    clearTimers();
    debounceTimer = setTimeout(() => {
      void executeSave();
    }, delayMs);
  };

  const saveNow = async (opts: { createSnapshot?: boolean; snapshotNote?: string } = {}) => {
    clearTimers();
    return executeSave(opts);
  };

  const acceptExternalContent = (doc: { type: 'doc'; content: any[] }, revision: number, updatedAt?: string) => {
    clearTimers();
    currentDoc = doc;
    lastSavedSerialized = JSON.stringify(doc);
    editSeq++;
    lastSavedSeq = editSeq;
    clearLocalDraft(options.novelId, options.chapterId, options.storage);
    emit({
      status: 'saved',
      revision,
      lastSavedAt: updatedAt || new Date().toISOString(),
      errorMessage: null,
      retryCount: 0,
      conflictRevision: undefined,
    });
  };

  const hasUnsavedChanges = () => {
    return editSeq > lastSavedSeq || JSON.stringify(currentDoc) !== lastSavedSerialized || state.status === 'unsaved' || state.status === 'saving' || state.status === 'error';
  };

  const dispose = () => {
    disposed = true;
    clearTimers();
    if (inFlightAbort) inFlightAbort.abort();
  };

  return {
    getState: () => state,
    notifyEdit,
    saveNow,
    acceptExternalContent,
    hasUnsavedChanges,
    dispose,
  };
}
