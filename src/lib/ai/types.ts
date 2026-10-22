/**
 * Shared AI types for the Hugging Face Inference Providers integration.
 *
 * This module is deliberately free of server-only imports so both the browser
 * (status badges, selectors) and the server (registry, inference) can share the
 * same vocabulary.
 */

/** Verification state of a configured model. */
export type ModelAvailability =
  | 'unverified'
  | 'available'
  | 'unavailable'
  | 'unsupported'
  | 'authentication_required'
  | 'rate_limited'
  | 'temporarily_unavailable'
  | 'paid_only'
  | 'unknown';

/** Pricing classification. `unknown` is never treated as free. */
export type ModelPricing = 'free' | 'paid' | 'unknown';

export type ModelTask = 'text-generation' | 'text-to-image';

/** Why we believe what we believe about a model. */
export type VerificationSource =
  | 'unverified'
  | 'hub-metadata'
  | 'provider-mapping'
  | 'router-catalog'
  | 'live-inference'
  | 'mock';

export interface TextModelMetadata {
  id: string;
  name: string;
  category: string;
  task: 'text-generation';
  enabled: boolean;
  verified: boolean;
  availabilityStatus: ModelAvailability;
  pricingStatus: ModelPricing;
  license?: string;
  provider?: string;
  contextLength?: number;
  lastCheckedAt?: string;
  lastSuccessfulAt?: string;
  averageLatencyMs?: number;
  failureCount: number;
  successCount?: number;
  limitations?: string[];
  /** Adapter/base-model composition, only when a provider actually supports it. */
  adapter?: { kind: string; baseModel?: string; weightsPath?: string };
  verificationSource?: VerificationSource;
  verifiedAt?: string;
  disabledReason?: string;
}

export interface ImageModelMetadata {
  id: string;
  name: string;
  category: string;
  task: 'text-to-image';
  enabled: boolean;
  verified: boolean;
  availabilityStatus: ModelAvailability;
  pricingStatus: ModelPricing;
  provider?: string;
  license?: string;
  supportedSizes?: Array<{ width: number; height: number }>;
  supportsNegativePrompt?: boolean;
  lastCheckedAt?: string;
  lastSuccessfulAt?: string;
  averageLatencyMs?: number;
  failureCount: number;
  successCount?: number;
  limitations?: string[];
  adapter?: { kind: string; baseModel?: string; weightsPath?: string };
  verificationSource?: VerificationSource;
  verifiedAt?: string;
  disabledReason?: string;
}

export type AnyModelMetadata = TextModelMetadata | ImageModelMetadata;

export interface ModelRow {
  id: string;
  name: string;
  task: ModelTask;
  category: string;
  provider: string | null;
  availabilityStatus: ModelAvailability;
  pricingStatus: ModelPricing;
  license: string | null;
  enabled: boolean;
  verified: boolean;
  contextLength: number | null;
  supportedSizes: string | null;
  supportsNegativePrompt: boolean | null;
  limitations: string | null;
  adapter: string | null;
  verificationSource: VerificationSource;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessfulAt: string | null;
  averageLatencyMs: number | null;
  failureCount: number;
  successCount: number;
  isPrimary: boolean;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Failure taxonomy used by the classifier, the retry policy and the UI. */
export type AiErrorCategory =
  | 'authentication_failed'
  | 'permission_denied'
  | 'gated_model'
  | 'model_not_found'
  | 'unsupported_task'
  | 'provider_unsupported'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'timeout'
  | 'network_error'
  | 'provider_outage'
  | 'invalid_request'
  | 'content_policy'
  | 'empty_output'
  | 'malformed_output'
  | 'invalid_image'
  | 'paid_inference_required'
  | 'configuration_error'
  | 'unknown';

export interface AiErrorInfo {
  category: AiErrorCategory;
  /** Message safe to show to a user: no tokens, no stack traces. */
  userMessage: string;
  /** Whether retrying the *same* model could succeed. */
  retryable: boolean;
  /** Whether falling back to another model could succeed. */
  fallbackable: boolean;
  /** Availability to record on the model when this error is returned. */
  availability?: ModelAvailability;
  status?: number;
  provider?: string;
  /** `Retry-After` in ms when the provider supplied one. */
  retryAfterMs?: number;
}

export interface TextGenerationRequest {
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  maxNewTokens?: number;
  temperature?: number;
  topP?: number;
  signal?: AbortSignal;
  /** Force a JSON object response when the provider supports structured output. */
  responseFormat?: 'text' | 'json_object';
  /** Optional provider override (defaults to the configured policy). */
  provider?: string;
}

export interface GenerationCost {
  amount?: number;
  currency?: string;
  status: 'confirmed' | 'estimated' | 'unknown';
}

export interface TextGenerationResult {
  text: string;
  requestedModelId: string;
  actualModelId: string;
  provider?: string;
  fallbackUsed: boolean;
  attempts: number;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  cost?: GenerationCost;
  attempts_detail?: Array<{ modelId: string; provider?: string; category: AiErrorCategory | 'success'; latencyMs: number }>;
}

export interface ImageGenerationRequest {
  modelId: string;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  signal?: AbortSignal;
  provider?: string;
  /** Number of images (1 by default; bounded by config). */
  n?: number;
}

export interface ImageGenerationResult {
  /** Raw image bytes, already validated as a supported image format. */
  image: Buffer;
  mimeType: string;
  requestedModelId: string;
  actualModelId: string;
  provider?: string;
  fallbackUsed: boolean;
  attempts: number;
  latencyMs: number;
  width?: number;
  height?: number;
  cost?: GenerationCost;
  attempts_detail?: Array<{ modelId: string; provider?: string; category: AiErrorCategory | 'success'; latencyMs: number }>;
}

export interface ModelFilters {
  task?: ModelTask;
  search?: string;
  category?: string;
  availability?: ModelAvailability[];
  pricing?: ModelPricing[];
  enabled?: boolean;
  provider?: string;
}

export const MODEL_AVAILABILITY_LABELS: Record<ModelAvailability, string> = {
  unverified: 'Unverified',
  available: 'Available',
  unavailable: 'Unavailable',
  unsupported: 'Unsupported',
  authentication_required: 'Auth required',
  rate_limited: 'Rate limited',
  temporarily_unavailable: 'Temporarily down',
  paid_only: 'Paid only',
  unknown: 'Unknown',
};

export const MODEL_PRICING_LABELS: Record<ModelPricing, string> = {
  free: 'Free',
  paid: 'Paid',
  unknown: 'Unknown pricing',
};

export const ERROR_CATEGORY_LABELS: Record<AiErrorCategory, string> = {
  authentication_failed: 'Authentication failed',
  permission_denied: 'Permission denied',
  gated_model: 'Gated model',
  model_not_found: 'Model not found',
  unsupported_task: 'Unsupported task',
  provider_unsupported: 'Provider unsupported',
  rate_limited: 'Rate limited',
  quota_exceeded: 'Quota exceeded',
  timeout: 'Timeout',
  network_error: 'Network error',
  provider_outage: 'Provider outage',
  invalid_request: 'Invalid request',
  content_policy: 'Content policy',
  empty_output: 'Empty output',
  malformed_output: 'Malformed output',
  invalid_image: 'Invalid image',
  paid_inference_required: 'Paid inference required',
  configuration_error: 'Configuration error',
  unknown: 'Unknown error',
};
