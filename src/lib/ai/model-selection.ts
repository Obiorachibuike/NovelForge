/**
 * Explainable model selection.
 *
 * Selection is a filter (eligibility) followed by a score (preference). It is
 * deterministic, unit-testable and never "first entry in the array": every
 * candidate carries the reasons it was chosen or skipped so the UI and the logs
 * can explain the decision.
 */
import 'server-only';
import { HttpError } from '@/lib/api/http';
import { isCircuitClosed } from './circuit-breaker';
import { aiPolicy, pricingAllowed, type AiPolicyConfig } from './config';
import { getModelRow, getPrimaryModel, listModelRows, type ListOptions } from './model-registry';
import type { ModelAvailability, ModelRow, ModelTask } from './types';

/** Availability states that make a model ineligible right now. */
const INELIGIBLE_AVAILABILITY: Record<ModelAvailability, string | null> = {
  unverified: null, // eligibility depends on the pricing policy, handled below
  available: null,
  unavailable: 'The model is not served by any configured provider.',
  unsupported: 'The model architecture is unsupported for this task.',
  authentication_required: 'The account does not have access to this model.',
  rate_limited: 'The model is currently rate limited.',
  temporarily_unavailable: 'The model is temporarily unavailable.',
  paid_only: 'The model requires paid inference.',
  unknown: 'The model state is unknown.',
};

export interface SelectionCandidate {
  model: ModelRow;
  score: number;
  reasons: string[];
  /** Set when the model is filtered out. */
  skippedReason?: string;
}

export interface SelectionResult {
  task: ModelTask;
  requestedModelId: string;
  /** Ordered, eligible candidates (best first). */
  candidates: SelectionCandidate[];
  /** Models considered but skipped, with the reason. */
  skipped: Array<{ modelId: string; reason: string }>;
  /** The model actually chosen, when there is one. */
  selected?: ModelRow;
  policy: {
    allowPaidInference: boolean;
    requireConfirmedPricing: boolean;
    fallbackEnabled: boolean;
    maxFallbackAttempts: number;
  };
}

export interface SelectOptions {
  /** 'auto' (default) or an explicit registered model id. */
  modelId?: string;
  task: ModelTask;
  /** When false only the requested model is returned (no fallback chain). */
  allowFallback?: boolean;
  /** Required context size in tokens, used to filter tiny models out. */
  requiredContextTokens?: number;
  /** Desired image size for image models. */
  requiredSize?: { width: number; height: number };
  policy?: AiPolicyConfig;
  /** Hard cap on candidates (bounding the fallback budget). */
  limit?: number;
}

function availabilitySkip(availability: ModelAvailability, policy: AiPolicyConfig): string | null {
  if (availability === 'paid_only' && !policy.allowPaidInference) {
    return 'The model requires paid inference and AI_ALLOW_PAID_INFERENCE=false.';
  }
  const reason = INELIGIBLE_AVAILABILITY[availability];
  if (reason) return reason;
  return null;
}

function supportsSize(model: ModelRow, size: { width: number; height: number }): boolean {
  if (!model.supportedSizes) return true; // unknown → do not block on it
  try {
    const sizes = JSON.parse(model.supportedSizes) as Array<{ width: number; height: number }>;
    if (!Array.isArray(sizes) || !sizes.length) return true;
    return sizes.some(s => s.width >= size.width && s.height >= size.height);
  } catch {
    return true;
  }
}

/**
 * Scores an eligible candidate. Higher is better. Deliberately does not rank by
 * parameter count: a 70B model is not automatically the right tool for a short
 * rewrite, and latency matters when generating 30 chapters.
 */
function scoreModel(model: ModelRow, options: SelectOptions, policy: AiPolicyConfig): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (model.availabilityStatus === 'available') {
    score += 40;
    reasons.push('Verified through a successful inference');
  } else if (model.verificationSource === 'provider-mapping' || model.verificationSource === 'router-catalog') {
    score += 20;
    reasons.push('Provider mapping confirms hosted support');
  } else if (model.verificationSource === 'hub-metadata') {
    score += 5;
    reasons.push('Repository verified, hosted support unconfirmed');
  } else {
    reasons.push('Not yet verified');
  }

  const attempts = model.successCount + model.failureCount;
  if (attempts > 0) {
    const successRate = model.successCount / attempts;
    score += Math.round(successRate * 30);
    reasons.push(`Historical success rate ${Math.round(successRate * 100)}% over ${attempts} attempt(s)`);
    if (model.failureCount > 0) score -= Math.min(20, model.failureCount * 4);
  }

  if (model.averageLatencyMs && model.averageLatencyMs > 0) {
    // Faster is better, with diminishing returns above ~20s.
    const latencyScore = Math.max(0, 25 - Math.round(model.averageLatencyMs / 800));
    score += latencyScore;
    reasons.push(`Average latency ${model.averageLatencyMs}ms`);
  }

  if (model.pricingStatus === 'free') {
    score += 15;
    reasons.push('Confirmed free inference');
  } else if (model.pricingStatus === 'unknown') {
    score -= 10;
    reasons.push('Pricing unconfirmed');
  }

  if (options.requiredContextTokens && model.contextLength) {
    if (model.contextLength >= options.requiredContextTokens) {
      score += 10;
      reasons.push(`Context ${model.contextLength.toLocaleString()} tokens is sufficient`);
    } else {
      score -= 30;
      reasons.push(`Context ${model.contextLength.toLocaleString()} tokens is below the required ${options.requiredContextTokens}`);
    }
  }

  const primary = getPrimaryModel(model.task);
  if (primary && primary.id === model.id) {
    score += 12;
    reasons.push('Configured as the primary model for this task');
  }

  if (!isCircuitClosed(model.id)) {
    score -= 50;
    reasons.push('Circuit breaker open after repeated failures');
  }

  void policy;
  return { score, reasons };
}

/**
 * Builds the ordered, eligible candidate list for a generation request.
 *
 * When `modelId` is an explicit registered model it is always placed first
 * (respecting the user's choice); the rest of the chain is used for fallback
 * only when fallback is enabled.
 */
export function selectModels(options: SelectOptions): SelectionResult {
  const policy = options.policy ?? aiPolicy();
  const requestedModelId = options.modelId && options.modelId !== 'auto' ? options.modelId : 'auto';

  const rows = listModelRows({ task: options.task } as ListOptions);
  const primary = getPrimaryModel(options.task);

  const candidates: SelectionCandidate[] = [];
  const skipped: Array<{ modelId: string; reason: string }> = [];

  for (const model of rows) {
    if (!model.enabled) {
      skipped.push({ modelId: model.id, reason: model.disabledReason || 'Disabled by an administrator.' });
      continue;
    }
    const availabilityReason = availabilitySkip(model.availabilityStatus, policy);
    if (availabilityReason) {
      skipped.push({ modelId: model.id, reason: availabilityReason });
      continue;
    }
    if (!pricingAllowed(model.pricingStatus, policy)) {
      skipped.push({
        modelId: model.id,
        reason:
          model.pricingStatus === 'unknown'
            ? 'Pricing is unknown and AI_REQUIRE_CONFIRMED_PRICING=true.'
            : 'Paid models are disabled by the current pricing policy.',
      });
      continue;
    }
    if (options.requiredContextTokens && model.contextLength && model.contextLength < options.requiredContextTokens) {
      skipped.push({
        modelId: model.id,
        reason: `Context window (${model.contextLength}) is smaller than the ${options.requiredContextTokens} tokens this request needs.`,
      });
      continue;
    }
    if (options.requiredSize && !supportsSize(model, options.requiredSize)) {
      skipped.push({ modelId: model.id, reason: 'The model does not support the requested image size.' });
      continue;
    }
    if (model.isPrimary === false && primary && primary.id !== model.id) {
      // no-op: kept for readability; primacy is a scoring bonus, not a filter
    }

    const { score, reasons } = scoreModel(model, options, policy);
    candidates.push({ model, score, reasons });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.model.id.localeCompare(b.model.id);
  });

  let ordered = candidates;
  if (requestedModelId !== 'auto') {
    const index = ordered.findIndex(c => c.model.id === requestedModelId);
    if (index === -1) {
      const requested = rows.find(r => r.id === requestedModelId);
      skipped.push({
        modelId: requestedModelId,
        reason: requested ? 'The requested model is not eligible under the current policy.' : 'The requested model is not registered.',
      });
    } else {
      const [requested] = ordered.splice(index, 1);
      ordered = [requested, ...ordered];
    }
  }

  const fallbackEnabled = options.allowFallback !== false && policy.fallbackEnabled;
  const limit = options.limit ?? (fallbackEnabled ? policy.maxFallbackAttempts : 1);
  const finalCandidates = ordered.slice(0, Math.max(1, limit));

  return {
    task: options.task,
    requestedModelId,
    candidates: finalCandidates,
    skipped,
    selected: finalCandidates[0]?.model,
    policy: {
      allowPaidInference: policy.allowPaidInference,
      requireConfirmedPricing: policy.requireConfirmedPricing,
      fallbackEnabled,
      maxFallbackAttempts: policy.maxFallbackAttempts,
    },
  };
}

/**
 * Validates a user-supplied model id.
 *
 * Only registered registry ids (or "auto") are accepted, so NovelForge can
 * never be used as an open proxy to arbitrary Hugging Face repositories.
 */
export function assertRegisteredModel(
  modelId: string | undefined | null,
  task: ModelTask,
): 'auto' | string {
  if (!modelId || modelId === 'auto' || modelId === '') return 'auto';
  const row = getModelRow(modelId);
  if (!row) {
    throw new HttpError(400, `Unknown model "${modelId}". Only registered NovelForge models can be selected.`, 'unknown_model');
  }
  if (row.task !== task) {
    throw new HttpError(400, `Model "${modelId}" is a ${row.task} model and cannot be used for ${task}.`, 'model_task_mismatch');
  }
  return modelId;
}

/** Human-readable explanation of why nothing was eligible. */
export function explainNoEligibleModel(result: SelectionResult): string {
  const reasons = new Set<string>();
  for (const skip of result.skipped) reasons.add(skip.reason);
  const detail = reasons.size ? `\n\nReasons observed:\n- ${Array.from(reasons).slice(0, 8).join('\n- ')}` : '';
  return [
    'No eligible hosted model is currently available.',
    '',
    'Possible reasons:',
    '- Every configured model still has unconfirmed pricing (run model verification first).',
    '- The configured models require paid inference and AI_ALLOW_PAID_INFERENCE=false.',
    '- Hosted inference is unsupported for the available models.',
    '- The account lacks access to the required (gated) models.',
    '- Provider quotas have been exhausted.',
    detail,
  ].join('\n');
}
