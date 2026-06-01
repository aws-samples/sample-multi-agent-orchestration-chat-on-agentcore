/**
 * Canonical Bedrock model definitions — Single Source of Truth.
 *
 * This file is the ONLY place to add, remove, or modify Bedrock model metadata.
 * It is imported by:
 *   - packages/frontend  (FALLBACK_MODELS)
 *   - packages/agent     (resolveMaxTokens)
 *
 * NOTE: packages/cdk intentionally does NOT import from @moca/core to keep
 * CDK infrastructure free of runtime library dependencies. When adding a model
 * here, also update DEFAULT_CONFIG.bedrockModels in
 * packages/cdk/config/environment-utils.ts.
 */

export interface BedrockModelDefinition {
  /** Full model ID including cross-region inference profile prefix */
  readonly id: string;
  /** Display name shown in the UI model selector */
  readonly name: string;
  /** Provider */
  readonly provider: 'Anthropic' | 'Amazon' | 'Qwen';
  /**
   * Maximum output tokens supported by this model.
   * Sources: Anthropic docs 2026-04, AWS docs.
   */
  readonly maxOutputTokens: number;
  /**
   * Optional invocation-region override.
   *
   * Most models are invoked in the deployment's BEDROCK_REGION. But some
   * In-Region-only models are not yet rolled out to every region (despite what
   * the AWS docs list), so they must be invoked in a region where they actually
   * exist. When set, createBedrockModel() routes this model's Bedrock calls to
   * this region regardless of BEDROCK_REGION. The IAM foundation-model ARN is
   * region-wildcarded (arn:aws:bedrock:*::foundation-model/…), so cross-region
   * invocation from another deployment region requires no extra IAM.
   *
   * Omit for models available in the deployment region (the common case).
   */
  readonly region?: string;
}

/**
 * The canonical list of available Bedrock models.
 *
 * Ordering: preferred/newest models first (affects default selection in UI).
 *
 * When adding a model, also update:
 *   - packages/cdk/config/environment-utils.ts  DEFAULT_CONFIG.bedrockModels
 */
export const BEDROCK_MODEL_DEFINITIONS = [
  {
    id: 'global.anthropic.claude-opus-4-8',
    name: 'Claude Opus 4.8',
    provider: 'Anthropic',
    maxOutputTokens: 128000, // 128k (AWS Bedrock model card, 2026-05-28)
  },
  {
    id: 'global.anthropic.claude-opus-4-7',
    name: 'Claude Opus 4.7',
    provider: 'Anthropic',
    maxOutputTokens: 128000, // 128k
  },
  {
    id: 'global.anthropic.claude-opus-4-6-v1',
    name: 'Claude Opus 4.6',
    provider: 'Anthropic',
    maxOutputTokens: 128000, // 128k
  },
  {
    id: 'global.anthropic.claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    maxOutputTokens: 64000, // 64k (Anthropic docs, 2026-04)
  },
  {
    id: 'global.amazon.nova-2-lite-v1:0',
    name: 'Nova Lite 2',
    provider: 'Amazon',
    maxOutputTokens: 5120, // AWS docs
  },
  {
    // In-Region only: Qwen3 has no cross-region inference profile prefix.
    // Note: bare model id with NO -v1:0 version suffix.
    // Note: Bedrock prompt caching is NOT supported for Qwen3 (Anthropic/Nova only).
    // Region pin: as of 2026-05 this model is NOT yet rolled out to the default
    // deployment region (ap-northeast-1) even though the AWS docs list Tokyo.
    // Verified via `aws bedrock get-foundation-model`: present in us-east-1,
    // ValidationException ("provided model identifier is invalid") in ap-northeast-1.
    // Pin invocation to us-east-1 until it ships in the deployment region.
    id: 'qwen.qwen3-coder-next',
    name: 'Qwen3 Coder Next',
    provider: 'Qwen',
    maxOutputTokens: 16384, // 16K — AWS Bedrock model card (qwen3-coder-next, 2026-02)
    region: 'us-east-1',
  },
] as const satisfies readonly BedrockModelDefinition[];

/** Strips cross-region inference profile prefixes (global., us., eu., apac., jp.) */
const PROFILE_PREFIX = /^(global|us|eu|apac|jp)\./;

function stripPrefix(modelId: string): string {
  return modelId.replace(PROFILE_PREFIX, '');
}

/**
 * Lookup the maxOutputTokens for a given modelId.
 *
 * Strips cross-region inference profile prefixes before comparing so that e.g.
 * `us.anthropic.claude-sonnet-4-6` matches the `global.*` entry.
 * Returns undefined if the model is not in the registry.
 */
export function getMaxOutputTokens(modelId: string): number | undefined {
  const stripped = stripPrefix(modelId);
  return BEDROCK_MODEL_DEFINITIONS.find((m) => stripPrefix(m.id) === stripped)?.maxOutputTokens;
}

/**
 * Lookup the invocation-region override for a given modelId, if any.
 *
 * Strips cross-region inference profile prefixes before comparing (mirrors
 * getMaxOutputTokens). Returns undefined when the model has no override (the
 * common case) or is not in the registry — callers should then fall back to
 * the deployment's BEDROCK_REGION.
 */
export function getModelRegion(modelId: string): string | undefined {
  const stripped = stripPrefix(modelId);
  // `region` is optional and present on only some entries; the `as const`
  // literal union otherwise hides it. Widen to the interface to read it.
  const match: BedrockModelDefinition | undefined = BEDROCK_MODEL_DEFINITIONS.find(
    (m) => stripPrefix(m.id) === stripped
  );
  return match?.region;
}
