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
   * Most models are invoked in the deployment's BEDROCK_REGION. But some must be
   * invoked in a specific region — an In-Region-only model not yet rolled out
   * everywhere (despite what the AWS docs list), or a model whose account-level
   * prerequisite (e.g. Bedrock Data Retention mode) is only enabled in certain
   * regions. When set, createBedrockModel() routes this model's Bedrock calls to
   * this region regardless of BEDROCK_REGION.
   *
   * IAM: the foundation-model ARN is region-wildcarded
   * (arn:aws:bedrock:*::foundation-model/…), but a cross-region inference profile
   * (global.*, us.*, …) ALSO needs an inference-profile ARN, which is
   * region-scoped. CDK's deriveBedrockIamResources() therefore scopes that ARN to
   * THIS region (not the deployment region) so the pinned-region invocation is
   * authorized. For that to work the matching CDK config entry
   * (DEFAULT_CONFIG.bedrockModels in packages/cdk/config/environment-utils.ts)
   * MUST carry the same `region` value — the two lists are synced by hand because
   * CDK does not import @moca/core.
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
 *     (mirror id/name/provider AND `region` if the model pins one — the region
 *     pin drives CDK's inference-profile IAM ARN, so an out-of-sync CDK entry
 *     causes AccessDenied at invocation time).
 */
export const BEDROCK_MODEL_DEFINITIONS = [
  {
    // Default model. No account-level prerequisite (unlike Fable 5's data
    // retention requirement), so it works out of the box in every region.
    id: 'global.anthropic.claude-opus-4-8',
    name: 'Claude Opus 4.8',
    provider: 'Anthropic',
    maxOutputTokens: 128000, // 128k (AWS Bedrock model card, 2026-05-28)
  },
  {
    // First Mythos-class model GA'd on Bedrock (2026-06-09). 1M context window,
    // 128k max output. Inference profile id verified ACTIVE via
    // `aws bedrock get-foundation-model` + a live ConverseCommand (PONG) in
    // us-east-1 / us-west-2.
    //
    // ⚠️ Data retention: Fable 5 (Mythos-class) can ONLY be invoked when the
    // account's Bedrock Data Retention mode is `provider_data_share` in the
    // invocation region. With the default mode the runtime rejects every
    // request — regardless of body — with:
    //   ValidationException: data retention mode 'default' is not available for this model
    // This is an account/region setting (Bedrock Data Retention API), not a
    // per-request field, so no code change works around it.
    //
    // No region pin: Fable 5 is invoked in the deployment's BEDROCK_REGION, so
    // its inference-profile IAM ARN (scoped to the deploy region by
    // deriveBedrockIamResources) matches the call. To use Fable 5, enable
    // provider_data_share in the deployment region (see README). If your
    // deployment region cannot enable it, pin Fable 5 to a region that has it
    // by overriding `bedrockModels` (with a `region`) in environments.ts —
    // that is environment-specific config and is kept OUT of this OSS default.
    id: 'global.anthropic.claude-fable-5',
    name: 'Claude Fable 5',
    provider: 'Anthropic',
    // 128k. NOTE: the Bedrock runtime enforces a hard ceiling of exactly
    // 128000 (verified live: maxTokens:131072 → ValidationException "exceeds the
    // model limit of 128000"). The issue's suggested 131072 is wrong — it would
    // make every request fail. Match the documented limit and the other Anthropic
    // entries here.
    maxOutputTokens: 128000, // 128k (verified via live ConverseCommand, 2026-06-09)
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
