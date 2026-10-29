/**
 * Database-backed model registry.
 *
 * `src/lib/ai/models.ts` is the source of truth for *which* models are
 * configured; this module is the source of truth for what we know about them
 * (availability, pricing, latency, failures) and what the operator has chosen
 * (enabled, primary). Verification fields are only ever advanced by the
 * verification service or a real successful inference — never by seeding.
 */
import 'server-only';
import { getDb } from '@/lib/db';
import {
  buildImageModelMetadata,
  buildTextModelMetadata,
  textToTextModels,
  textToImageModels,
} from './models';
import type {
  AiErrorCategory,
  ModelAvailability,
  ModelFilters,
  ModelPricing,
  ModelRow,
  ModelTask,
  VerificationSource,
} from './types';

const AVAILABILITY_VALUES: ModelAvailability[] = [
  'unverified',
  'available',
  'unavailable',
  'unsupported',
  'authentication_required',
  'rate_limited',
  'temporarily_unavailable',
  'paid_only',
  'unknown',
];

const PRICING_VALUES: ModelPricing[] = ['free', 'paid', 'unknown'];

function toBool(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return String(value) === '1' || String(value).toLowerCase() === 'true';
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Seeds any configured model that has no row yet and refreshes static fields
 * (name, category, limitations). Verification data is left untouched.
 *
 * Safe to call on every request path: it is a handful of indexed reads.
 */
export function syncRegistry(): { added: string[]; updated: number } {
  const db = getDb();
  const now = nowIso();
  const added: string[] = [];
  let updated = 0;

  const all = [...buildTextModelMetadata(), ...buildImageModelMetadata()];
  for (const model of all) {
    const existing = db.prepare('SELECT id, name, category, limitations FROM ai_model_registry WHERE id = ?').get(model.id) as
      | { id: string; name: string; category: string; limitations: string | null }
      | undefined;

    if (!existing) {
      db.prepare(
        `INSERT INTO ai_model_registry
           (id,name,task,category,provider,availabilityStatus,pricingStatus,license,enabled,verified,
            contextLength,supportedSizes,supportsNegativePrompt,limitations,adapter,verificationSource,
            failureCount,successCount,isPrimary,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        model.id,
        model.name,
        model.task,
        model.category,
        model.provider ?? null,
        model.availabilityStatus,
        model.pricingStatus,
        model.license ?? null,
        model.enabled ? 1 : 0,
        model.verified ? 1 : 0,
        ('contextLength' in model && model.contextLength) || null,
        ('supportedSizes' in model && model.supportedSizes) ? JSON.stringify(model.supportedSizes) : null,
        ('supportsNegativePrompt' in model && typeof model.supportsNegativePrompt === 'boolean') ? (model.supportsNegativePrompt ? 1 : 0) : null,
        model.limitations?.length ? JSON.stringify(model.limitations) : null,
        model.adapter ? JSON.stringify(model.adapter) : null,
        model.verificationSource ?? 'unverified',
        0,
        0,
        0,
        now,
        now,
      );
      added.push(model.id);
      continue;
    }

    const nextLimitations = model.limitations?.length ? JSON.stringify(model.limitations) : null;
    if (existing.name !== model.name || existing.category !== model.category || existing.limitations !== nextLimitations) {
      db.prepare('UPDATE ai_model_registry SET name=?, category=?, limitations=?, updatedAt=? WHERE id=?')
        .run(model.name, model.category, nextLimitations, now, model.id);
      updated++;
    }
  }
  return { added, updated };
}

function mapRow(row: any): ModelRow | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    task: row.task,
    category: row.category,
    provider: row.provider ?? null,
    availabilityStatus: AVAILABILITY_VALUES.includes(row.availabilityStatus) ? row.availabilityStatus : 'unknown',
    pricingStatus: PRICING_VALUES.includes(row.pricingStatus) ? row.pricingStatus : 'unknown',
    license: row.license ?? null,
    enabled: toBool(row.enabled),
    verified: toBool(row.verified),
    contextLength: toNumber(row.contextLength),
    supportedSizes: row.supportedSizes ?? null,
    supportsNegativePrompt: row.supportsNegativePrompt === null || row.supportsNegativePrompt === undefined
      ? null
      : toBool(row.supportsNegativePrompt),
    limitations: row.limitations ?? null,
    adapter: row.adapter ?? null,
    verificationSource: (row.verificationSource ?? 'unverified') as VerificationSource,
    verifiedAt: row.verifiedAt ?? null,
    lastCheckedAt: row.lastCheckedAt ?? null,
    lastSuccessfulAt: row.lastSuccessfulAt ?? null,
    averageLatencyMs: toNumber(row.averageLatencyMs),
    failureCount: toNumber(row.failureCount) ?? 0,
    successCount: toNumber(row.successCount) ?? 0,
    isPrimary: toBool(row.isPrimary),
    disabledReason: row.disabledReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getModelRow(modelId: string): ModelRow | null {
  const db = getDb();
  return mapRow(db.prepare('SELECT * FROM ai_model_registry WHERE id = ?').get(modelId));
}

export interface ListOptions extends ModelFilters {
  limit?: number;
  /** Include models that are still unverified (default true). */
  includeUnverified?: boolean;
}

export function listModelRows(options: ListOptions = {}): ModelRow[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.task) {
    where.push('task = ?');
    params.push(options.task);
  }
  if (options.category) {
    where.push('category = ?');
    params.push(options.category);
  }
  if (typeof options.enabled === 'boolean') {
    where.push('enabled = ?');
    params.push(options.enabled ? 1 : 0);
  }
  if (options.availability?.length) {
    where.push(`availabilityStatus IN (${options.availability.map(() => '?').join(',')})`);
    params.push(...options.availability);
  }
  if (options.pricing?.length) {
    where.push(`pricingStatus IN (${options.pricing.map(() => '?').join(',')})`);
    params.push(...options.pricing);
  }
  if (options.provider) {
    where.push('provider = ?');
    params.push(options.provider);
  }
  if (options.search) {
    const like = `%${options.search.toLowerCase()}%`;
    where.push('(LOWER(id) LIKE ? OR LOWER(name) LIKE ? OR LOWER(category) LIKE ?)');
    params.push(like, like, like);
  }

  const limit = Math.min(Math.max(1, options.limit ?? 200), 500);
  const sql = `SELECT * FROM ai_model_registry ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY task ASC, category ASC, id ASC LIMIT ?`;
  params.push(limit);
  return (db.prepare(sql).all(...params) as any[]).map(mapRow).filter(Boolean) as ModelRow[];
}

export interface ModelPatch {
  availabilityStatus?: ModelAvailability;
  pricingStatus?: ModelPricing;
  provider?: string | null;
  license?: string | null;
  contextLength?: number | null;
  supportedSizes?: Array<{ width: number; height: number }> | null;
  supportsNegativePrompt?: boolean | null;
  limitations?: string[] | null;
  adapter?: { kind: string; baseModel?: string; weightsPath?: string } | null;
  verificationSource?: VerificationSource;
  verified?: boolean;
  verifiedAt?: string | null;
  lastCheckedAt?: string;
  lastSuccessfulAt?: string | null;
  averageLatencyMs?: number | null;
  enabled?: boolean;
  disabledReason?: string | null;
}

const PATCH_COLUMNS: Record<keyof ModelPatch, string> = {
  availabilityStatus: 'availabilityStatus',
  pricingStatus: 'pricingStatus',
  provider: 'provider',
  license: 'license',
  contextLength: 'contextLength',
  supportedSizes: 'supportedSizes',
  supportsNegativePrompt: 'supportsNegativePrompt',
  limitations: 'limitations',
  adapter: 'adapter',
  verificationSource: 'verificationSource',
  verified: 'verified',
  verifiedAt: 'verifiedAt',
  lastCheckedAt: 'lastCheckedAt',
  lastSuccessfulAt: 'lastSuccessfulAt',
  averageLatencyMs: 'averageLatencyMs',
  enabled: 'enabled',
  disabledReason: 'disabledReason',
};

/** Applies a partial patch to a registry row. Returns the updated row. */
export function patchModel(modelId: string, patch: ModelPatch): ModelRow | null {
  const db = getDb();
  if (!getModelRow(modelId)) return null;
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const [key, column] of Object.entries(PATCH_COLUMNS) as Array<[keyof ModelPatch, string]>) {
    const value = patch[key];
    if (value === undefined) continue;
    if (key === 'supportedSizes' || key === 'limitations' || key === 'adapter') {
      sets.push(`${column}=?`);
      values.push(value === null ? null : JSON.stringify(value));
      continue;
    }
    if (key === 'verified' || key === 'enabled' || key === 'supportsNegativePrompt') {
      sets.push(`${column}=?`);
      values.push(value === null ? null : value ? 1 : 0);
      continue;
    }
    sets.push(`${column}=?`);
    values.push(value as unknown);
  }
  if (!sets.length) return getModelRow(modelId);

  sets.push('updatedAt=?');
  values.push(nowIso());
  values.push(modelId);
  db.prepare(`UPDATE ai_model_registry SET ${sets.join(',')} WHERE id=?`).run(...values);
  return getModelRow(modelId);
}

export function setModelEnabled(modelId: string, enabled: boolean, reason?: string): ModelRow | null {
  return patchModel(modelId, {
    enabled,
    disabledReason: enabled ? null : reason ?? 'Disabled by an administrator.',
  });
}

/** Sets the primary (preferred) model for a task. Pass null to clear. */
export function setPrimaryModel(task: ModelTask, modelId: string | null): void {
  const db = getDb();
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare('UPDATE ai_model_registry SET isPrimary=0, updatedAt=? WHERE task=?').run(now, task);
    if (modelId) {
      db.prepare('UPDATE ai_model_registry SET isPrimary=1, updatedAt=? WHERE id=? AND task=?').run(now, modelId, task);
    }
  });
  tx();
}

export function getPrimaryModel(task: ModelTask): ModelRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ai_model_registry WHERE task=? AND isPrimary=1').get(task);
  return mapRow(row);
}

export interface RecordSuccessInput {
  provider?: string;
  latencyMs: number;
  task?: ModelTask;
  /** Verification source to record (live inference by default). */
  source?: VerificationSource;
}

/** Records a successful inference: availability, latency EMA, success count. */
export function recordModelSuccess(modelId: string, input: RecordSuccessInput): void {
  const db = getDb();
  const now = nowIso();
  const row = getModelRow(modelId);
  if (!row) return;
  const previousAverage = row.averageLatencyMs;
  const nextAverage =
    previousAverage && previousAverage > 0
      ? Math.round(previousAverage * 0.7 + Math.max(0, input.latencyMs) * 0.3)
      : Math.round(Math.max(0, input.latencyMs));

  db.prepare(
    `UPDATE ai_model_registry
        SET availabilityStatus='available',
            verified=1,
            verificationSource=?,
            verifiedAt=?,
            lastSuccessfulAt=?,
            lastCheckedAt=?,
            successCount=successCount+1,
            failureCount=0,
            averageLatencyMs=?,
            provider=COALESCE(?, provider),
            updatedAt=?
      WHERE id=?`,
  ).run(
    input.source ?? 'live-inference',
    now,
    now,
    now,
    nextAverage,
    input.provider ?? null,
    now,
    modelId,
  );
  recordModelEvent({
    modelId,
    task: input.task,
    kind: 'inference',
    ok: true,
    provider: input.provider,
    latencyMs: Math.round(input.latencyMs),
    message: 'Successful inference',
  });
}

export interface RecordFailureInput {
  category: AiErrorCategory;
  availability?: ModelAvailability;
  message?: string;
  provider?: string;
  latencyMs?: number;
  task?: ModelTask;
}

/** Records a failed inference/verification: failure count, availability, event. */
export function recordModelFailure(modelId: string, input: RecordFailureInput): void {
  const db = getDb();
  const now = nowIso();
  if (!getModelRow(modelId)) return;
  db.prepare(
    `UPDATE ai_model_registry
        SET availabilityStatus=?,
            failureCount=failureCount+1,
            lastCheckedAt=?,
            updatedAt=?
      WHERE id=?`,
  ).run(input.availability ?? 'unknown', now, now, modelId);
  recordModelEvent({
    modelId,
    task: input.task,
    kind: 'inference',
    ok: false,
    category: input.category,
    provider: input.provider,
    latencyMs: input.latencyMs === undefined ? undefined : Math.round(input.latencyMs),
    message: input.message?.slice(0, 500),
  });
}

export interface ModelEventInput {
  modelId: string;
  task?: ModelTask;
  kind: 'verification' | 'inference' | 'admin';
  ok: boolean;
  category?: AiErrorCategory;
  provider?: string;
  latencyMs?: number;
  message?: string;
}

export function recordModelEvent(input: ModelEventInput): void {
  try {
    const db = getDb();
    const crypto = require('node:crypto') as typeof import('node:crypto');
    db.prepare(
      `INSERT INTO ai_model_events (id,modelId,task,kind,ok,category,provider,latencyMs,message,createdAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      input.modelId,
      input.task ?? null,
      input.kind,
      input.ok ? 1 : 0,
      input.category ?? null,
      input.provider ?? null,
      input.latencyMs ?? null,
      input.message?.slice(0, 1_000) ?? null,
      nowIso(),
    );
  } catch (err) {
    // Accounting must never break a generation.
    console.warn('[ai] recordModelEvent failed:', err);
  }
}

export interface ModelEvent {
  id: string;
  modelId: string;
  task: string | null;
  kind: string;
  ok: boolean;
  category: string | null;
  provider: string | null;
  latencyMs: number | null;
  message: string | null;
  createdAt: string;
}

export function recentModelEvents({ limit = 50, onlyFailures = false, modelId }: { limit?: number; onlyFailures?: boolean; modelId?: string } = {}): ModelEvent[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (onlyFailures) where.push('ok = 0');
  if (modelId) {
    where.push('modelId = ?');
    params.push(modelId);
  }
  const sql = `SELECT * FROM ai_model_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY createdAt DESC LIMIT ?`;
  params.push(Math.min(Math.max(1, limit), 200));
  return (db.prepare(sql).all(...params) as any[]).map(row => ({
    id: row.id,
    modelId: row.modelId,
    task: row.task ?? null,
    kind: row.kind,
    ok: toBool(row.ok),
    category: row.category ?? null,
    provider: row.provider ?? null,
    latencyMs: toNumber(row.latencyMs),
    message: row.message ?? null,
    createdAt: row.createdAt,
  }));
}

export interface RegistryOverview {
  configured: { text: number; image: number; total: number };
  registered: { text: number; image: number; total: number };
  byAvailability: Record<string, number>;
  byPricing: Record<string, number>;
  verifiedRepositories: number;
  hostedInferenceSupported: number;
  successfullyTested: number;
  unavailable: number;
  unsupported: number;
  authenticationRequired: number;
  enabled: number;
  disabled: number;
  primary: { text: string | null; image: string | null };
  recentFailures: number;
  recentSuccesses: number;
}

/**
 * Dashboard counts. Every number is computed from persisted state, so the UI
 * can never show a configured model as operational without evidence.
 */
export function registryOverview(): RegistryOverview {
  syncRegistry();
  const rows = listModelRows({ limit: 500 });
  const text = rows.filter(r => r.task === 'text-generation');
  const image = rows.filter(r => r.task === 'text-to-image');

  const byAvailability: Record<string, number> = {};
  const byPricing: Record<string, number> = {};
  for (const row of rows) {
    byAvailability[row.availabilityStatus] = (byAvailability[row.availabilityStatus] ?? 0) + 1;
    byPricing[row.pricingStatus] = (byPricing[row.pricingStatus] ?? 0) + 1;
  }

  const availability = (status: ModelAvailability) => rows.filter(r => r.availabilityStatus === status).length;
  const failures = recentModelEvents({ limit: 200, onlyFailures: true });
  const successes = recentModelEvents({ limit: 200 }).filter(e => e.ok);

  return {
    configured: {
      text: textToTextModels.length,
      image: textToImageModels.length,
      total: textToTextModels.length + textToImageModels.length,
    },
    registered: { text: text.length, image: image.length, total: rows.length },
    byAvailability,
    byPricing,
    // "Verified repository" = the Hub confirmed the repository exists.
    verifiedRepositories: rows.filter(r => r.verified || r.verificationSource !== 'unverified').length,
    // Hosted inference supported = a provider is recorded or a live call worked.
    hostedInferenceSupported: rows.filter(r => !!r.provider || r.availabilityStatus === 'available').length,
    successfullyTested: rows.filter(r => r.verificationSource === 'live-inference' || r.successCount > 0).length,
    unavailable: availability('unavailable'),
    unsupported: availability('unsupported'),
    authenticationRequired: availability('authentication_required'),
    enabled: rows.filter(r => r.enabled).length,
    disabled: rows.filter(r => !r.enabled).length,
    primary: {
      text: getPrimaryModel('text-generation')?.id ?? null,
      image: getPrimaryModel('text-to-image')?.id ?? null,
    },
    recentFailures: failures.length,
    recentSuccesses: successes.length,
  };
}

/** Test helper: drops registry rows so tests start from a clean slate. */

export interface CreateModelInput {
  id: string;
  name?: string;
  task: ModelTask;
  category?: string;
  provider?: string | null;
  contextLength?: number | null;
  pricingStatus?: ModelPricing;
  availabilityStatus?: ModelAvailability;
  limitations?: string[];
  license?: string | null;
  supportedSizes?: Array<{ width: number; height: number }> | null;
  enabled?: boolean;
}

/**
 * Administrator-only: creates a new model row.
 */
export function createModel(input: CreateModelInput): ModelRow {
  const db = getDb();
  const now = nowIso();
  const trimmedId = input.id.trim();
  if (!trimmedId) throw new Error('Model id is required.');
  if (/\s/.test(trimmedId)) throw new Error('Model id cannot contain whitespace.');
  if (getModelRow(trimmedId)) throw new Error(`Model "${trimmedId}" already exists.`);
  if (input.task !== 'text-generation' && input.task !== 'text-to-image') {
    throw new Error('task must be "text-generation" or "text-to-image".');
  }
  const name = (input.name?.trim() || displayNameFromId(trimmedId));
  const category = input.category?.trim() || (input.task === 'text-generation' ? 'Custom · Text' : 'Custom · Image');
  db.prepare(
    `INSERT INTO ai_model_registry
       (id,name,task,category,provider,availabilityStatus,pricingStatus,license,enabled,verified,
        contextLength,supportedSizes,supportsNegativePrompt,limitations,adapter,verificationSource,
        failureCount,successCount,isPrimary,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    trimmedId,
    name,
    input.task,
    category,
    input.provider ?? null,
    input.availabilityStatus ?? 'unverified',
    input.pricingStatus ?? 'unknown',
    input.license ?? null,
    input.enabled !== false ? 1 : 0,
    0,
    input.contextLength ?? null,
    input.supportedSizes ? JSON.stringify(input.supportedSizes) : null,
    null,
    input.limitations?.length ? JSON.stringify(input.limitations) : null,
    null,
    'unverified',
    0,
    0,
    0,
    now,
    now,
  );
  recordModelEvent({
    modelId: trimmedId,
    task: input.task,
    kind: 'admin',
    ok: true,
    message: `Created by administrator (${category})`,
  });
  return getModelRow(trimmedId)!;
}

function displayNameFromId(id: string): string {
  if (!id.includes('/')) {
    return id.replace(/^agnes-?/i, 'Agnes ').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || id;
  }
  const [, name] = id.split('/');
  return name || id;
}

/**
 * Administrator-only: deletes a model row and its events.
 */
export function deleteModel(modelId: string): boolean {
  const db = getDb();
  const row = getModelRow(modelId);
  if (!row) return false;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM ai_model_events WHERE modelId = ?').run(modelId);
    if (row.isPrimary) {
      db.prepare('UPDATE ai_model_registry SET isPrimary=0 WHERE id=?').run(modelId);
    }
    db.prepare('DELETE FROM ai_model_registry WHERE id = ?').run(modelId);
  });
  tx();
  return true;
}

export function resetRegistryForTests(): void {
  const db = getDb();
  db.prepare('DELETE FROM ai_model_events').run();
  db.prepare('DELETE FROM ai_model_registry').run();
}
