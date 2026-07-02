/**
 * Available Bedrock Models Configuration
 *
 * Models are configured via VITE_BEDROCK_MODELS environment variable (set by CDK).
 * Falls back to BEDROCK_MODEL_DEFINITIONS from @moca/core (Single Source of Truth).
 */

import { BEDROCK_MODEL_DEFINITIONS } from '@moca/core';

export interface BedrockModel {
  id: string;
  name: string;
  provider: 'Anthropic' | 'Amazon' | 'Qwen' | 'OpenAI';
}

const VALID_PROVIDERS: ReadonlySet<BedrockModel['provider']> = new Set([
  'Anthropic',
  'Amazon',
  'Qwen',
  'OpenAI',
]);

/**
 * Fallback model list derived from the canonical BEDROCK_MODEL_DEFINITIONS.
 * Do NOT edit this list directly — update packages/libs/core/src/bedrock-models.ts.
 */
const FALLBACK_MODELS: readonly BedrockModel[] = BEDROCK_MODEL_DEFINITIONS.map(
  ({ id, name, provider }) => ({ id, name, provider })
);

function isValidModel(m: unknown): m is BedrockModel {
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof (m as Record<string, unknown>).id === 'string' &&
    ((m as Record<string, unknown>).id as string).length > 0 &&
    typeof (m as Record<string, unknown>).name === 'string' &&
    ((m as Record<string, unknown>).name as string).length > 0 &&
    VALID_PROVIDERS.has((m as Record<string, unknown>).provider as BedrockModel['provider'])
  );
}

function loadModels(): readonly BedrockModel[] {
  try {
    const raw = import.meta.env.VITE_BEDROCK_MODELS;
    if (!raw) return FALLBACK_MODELS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return FALLBACK_MODELS;
    const valid = parsed.filter(isValidModel);
    return valid.length > 0 ? valid : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

/**
 * Available Bedrock models (from CDK environment config or fallback)
 */
export const AVAILABLE_MODELS: readonly BedrockModel[] = loadModels();

/**
 * Default model ID (first model in the list)
 */
export const DEFAULT_MODEL_ID = AVAILABLE_MODELS[0]?.id ?? 'global.anthropic.claude-sonnet-4-6';

/**
 * Get model by ID
 */
export function getModelById(id: string): BedrockModel | undefined {
  return AVAILABLE_MODELS.find((model) => model.id === id);
}

/**
 * Get model display name
 */
export function getModelDisplayName(id: string): string {
  const model = getModelById(id);
  return model ? `${model.name} (${model.provider})` : id;
}
