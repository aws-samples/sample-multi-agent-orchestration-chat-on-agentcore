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
  readonly provider: 'Anthropic' | 'Amazon';
  /**
   * Maximum output tokens supported by this model.
   * Sources: Anthropic docs 2026-04, AWS docs.
   */
  readonly maxOutputTokens: number;
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
