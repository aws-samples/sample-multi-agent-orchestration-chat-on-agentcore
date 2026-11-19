/**
 * CDK Configuration Files
 *
 * File structure:
 * - environments.ts      : Environment settings (edit this for deployment)
 * - environment-types.ts : Type definitions
 * - environment-utils.ts : Logic (getEnvironmentConfig, etc.)
 */

// Export type definitions
export type {
  Environment,
  EnvironmentConfig,
  EnvironmentConfigInput,
  BedrockModelConfig,
  EventRuleConfig,
  WebSearchProvider,
  AgentCoreWebSearchConfig,
  RuntimePlatformVersion,
  RuntimeMinimumMemoryMiB,
} from './environment-types';
export { RUNTIME_MINIMUM_MEMORY_MIB_VALUES } from './environment-types';

// Export configurations
export { BASE_PREFIX, environments } from './environments';

// Export utilities
export {
  getEnvironmentConfig,
  deriveBedrockIamResources,
  hasBedrockOpenAiModel,
  hasMantleModel,
  assertWebSearchProviderRegion,
  AGENTCORE_WEB_SEARCH_REGIONS,
  validateRuntimeResources,
  RUNTIME_MINIMUM_MEMORY_CFN_SUPPORTED,
} from './environment-utils';
