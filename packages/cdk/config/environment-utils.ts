/**
 * Environment configuration utilities
 * Contains logic for resolving environment configurations with defaults
 */

import * as cdk from 'aws-cdk-lib';
import type {
  BedrockModelConfig,
  BedrockEndpoint,
  Provider,
  Environment,
  EnvironmentConfig,
  EnvironmentConfigInput,
} from './environment-types';
import { BASE_PREFIX, environments } from './environments';

/**
 * The Bedrock model catalog, loaded from @moca/core by the composition root
 * (bin/app.ts) and passed explicitly into {@link getEnvironmentConfig}.
 *
 * WHY passed as an argument rather than imported: @moca/core is an ESM package
 * (`type: module`); CDK compiles as CommonJS (ts-node / ts-jest, `module:
 * Node16`/`commonjs`), so a static `import { BEDROCK_MODEL_DEFINITIONS }` emits
 * a `require()` of an ESM module (TS1479) and jest cannot resolve the package
 * at all. bin/app.ts is the one place that can `await import('@moca/core')`, so
 * it loads the catalog once and threads it through the config functions. Passing
 * it (rather than stashing it in module state) makes "load core before resolving
 * config" a compile-time signature requirement instead of a runtime precondition.
 */
export interface ModelCatalog {
  /** Providers allowlist (core PROVIDERS). */
  readonly providers: readonly Provider[];
  /**
   * Default enabled models, projected from core's BEDROCK_MODEL_DEFINITIONS to
   * the CDK-relevant fields (id/name/provider/region/endpoint).
   */
  readonly defaultModels: readonly BedrockModelConfig[];
}

/**
 * The subset of a @moca/core BedrockModelDefinition that CDK config needs.
 * Kept structural (not an import of the core type) so this stays a plain
 * projection contract; bin/app.ts passes core's definitions straight in.
 */
interface CoreModelDefinition {
  readonly id: string;
  readonly name: string;
  readonly provider: Provider;
  readonly region?: string;
  readonly endpoint?: BedrockModelConfig['endpoint'];
}

/**
 * Build a {@link ModelCatalog} from @moca/core's PROVIDERS + BEDROCK_MODEL_DEFINITIONS.
 * Called by bin/app.ts after dynamic-importing core. Projects each model to the
 * CDK-relevant fields (id/name/provider/region/endpoint); maxOutputTokens and
 * reasoning metadata are intentionally dropped — CDK does not use them.
 */
export function buildModelCatalog(
  providers: readonly Provider[],
  definitions: readonly CoreModelDefinition[]
): ModelCatalog {
  return {
    providers,
    defaultModels: definitions.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      ...(m.region !== undefined ? { region: m.region } : {}),
      ...(m.endpoint !== undefined ? { endpoint: m.endpoint } : {}),
    })),
  };
}

const INFERENCE_PROFILE_STRIP = /^(global|us|eu|apac|jp)\./;

/**
 * Derive Bedrock IAM resource ARNs from bedrockModels config.
 *
 * Generates:
 * - inference-profile ARN for cross-region routing
 * - foundation-model ARN for direct model access
 *
 * NOTE: Nova Reel async-invoke resources are intentionally excluded here.
 * Nova Reel is executed exclusively by the Gateway Target Lambda (NovaReelToolsTarget),
 * which manages its own IAM policy with async-invoke permissions.
 *
 * @param region The DEPLOYMENT region — used for any model that does not pin its
 *   own region. A model with `region` set overrides this for its inference-profile
 *   ARN so the grant matches the region the agent actually invokes it in.
 */
export function deriveBedrockIamResources(
  models: BedrockModelConfig[],
  region: string,
  account: string
): string[] {
  const resources: string[] = [];

  for (const model of models) {
    // Inference profile ARN (only for cross-region inference profile IDs, e.g.
    // global.*, us.*, etc.). In-Region models (e.g. qwen.*) have no inference
    // profile, so we skip this ARN to keep the IAM policy least-privilege.
    if (INFERENCE_PROFILE_STRIP.test(model.id)) {
      // A region-pinned model is invoked in model.region (via @moca/core
      // getModelRegion), so the inference-profile ARN MUST be scoped to that
      // region — not the deployment region — or InvokeModel is AccessDenied.
      const profileRegion = model.region ?? region;
      resources.push(`arn:aws:bedrock:${profileRegion}:${account}:inference-profile/${model.id}`);
    }

    // Foundation model ARN (strip inference profile prefix for direct access).
    // Region-wildcarded, so a region pin needs no change here.
    // For bare In-Region IDs this is the only resource needed.
    const baseId = model.id.replace(INFERENCE_PROFILE_STRIP, '');
    resources.push(`arn:aws:bedrock:*::foundation-model/${baseId}*`);
  }

  return [...new Set(resources)];
}

/**
 * Default configuration values
 * All environments inherit these defaults unless explicitly overridden
 */
const DEFAULT_CONFIG = {
  deletionProtection: false,
  corsAllowedOrigins: ['*'] as string[],
  memoryExpirationDays: 30,
  s3RemovalPolicy: cdk.RemovalPolicy.DESTROY,
  s3AutoDeleteObjects: true,
  cognitoDeletionProtection: false,
  logRetentionDays: 7,
  tavilyApiKeySecretName: 'agentcore/default/tavily-api-key',
  githubTokenSecretName: 'agentcore/default/github-token',
  githubWebhookSecretName: 'agentcore/default/github-webhook-secret',
  // Default geo restriction: Japan and United States
  // Override per-environment in environments.ts if needed
  cloudFrontGeoRestriction: ['JP', 'US'] as string[],
  // NOTE: the default Bedrock model list is NOT hardcoded here anymore. It is
  // derived from @moca/core's BEDROCK_MODEL_DEFINITIONS (the single source of
  // truth) via buildModelCatalog() and passed into getEnvironmentConfig();
  // resolveConfig() reads it from that catalog. This removes the hand-synced
  // duplicate that previously drifted from core (a wrong region/endpoint here
  // silently mis-scoped IAM → AccessDenied).
};

/**
 * Whether any configured model uses the given non-Converse Bedrock endpoint.
 * Used by the task-role IAM to gate the endpoint-specific statements, which
 * differ by AWS service:
 *   - `'bedrock-openai'` (gpt-oss, bedrock-runtime `/openai/v1`) →
 *     `bedrock:InvokeModel*` + `bedrock:CallWithBearerToken`.
 *   - `'mantle'` (gpt-5.x, Bedrock Mantle host) → the SEPARATE `bedrock-mantle:`
 *     service (CreateInference / Get* / List* on `project/*` + CallWithBearerToken).
 */
export function hasEndpointModel(
  models: BedrockModelConfig[],
  endpoint: BedrockEndpoint
): boolean {
  return models.some((m) => m.endpoint === endpoint);
}

/**
 * A routable Bedrock model id must be namespaced: one or more `vendor.` segments
 * followed by a model name. This accepts both cross-region inference profile IDs
 * (e.g. `global.anthropic.claude-sonnet-4-6`) and bare In-Region foundation-model
 * IDs (e.g. `qwen.qwen3-235b-a22b-2507-v1:0`). The check guards against
 * typos / unqualified IDs rather than enforcing a specific inference profile prefix.
 */
const NAMESPACED_MODEL_ID = /^([a-z0-9-]+\.)+[a-z0-9][a-z0-9.:_-]*$/;

/**
 * AWS region token, e.g. `us-east-1`, `ap-northeast-1`, `eu-central-1`.
 * Lowercase only; guards a model's optional `region` pin against typos like
 * `US-East-1` that would silently produce an unmatched IAM ARN.
 */
const AWS_REGION_TOKEN = /^[a-z]{2}-[a-z]+-\d+$/;

/**
 * Cognito domain prefix regex.
 *   - 3-63 chars total
 *   - Lowercase alphanumeric and hyphens only
 *   - Must not start or end with a hyphen
 * Cognito additionally reserves prefixes beginning with "aws", "amazon", or
 * "cognito"; this is enforced separately in validateCognitoDomainPrefix.
 */
const COGNITO_DOMAIN_PREFIX_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const COGNITO_RESERVED_PREFIX = /^(aws|amazon|cognito)/;

/**
 * Validate cognitoDomainPrefix configuration.
 * Called during resolveConfig so errors surface at cdk synth / deploy time.
 */
function validateCognitoDomainPrefix(prefix: string | undefined, env: Environment): void {
  if (!prefix) {
    throw new Error(
      `[${env}] cognitoDomainPrefix is required. ` +
        'Set it in environments.ts — Cognito domain prefixes share a GLOBAL namespace, ' +
        'so each environment must pick a value unique across all AWS accounts/regions.'
    );
  }
  if (!COGNITO_DOMAIN_PREFIX_REGEX.test(prefix)) {
    throw new Error(
      `[${env}] cognitoDomainPrefix "${prefix}" is invalid. ` +
        'Must be 3-63 characters, lowercase alphanumeric and hyphens only, ' +
        'not starting or ending with a hyphen.'
    );
  }
  if (COGNITO_RESERVED_PREFIX.test(prefix)) {
    throw new Error(
      `[${env}] cognitoDomainPrefix "${prefix}" must not start with "aws", "amazon", or "cognito".`
    );
  }
}

/**
 * Validate bedrockModels configuration
 * Called during resolveConfig so errors surface at cdk synth / deploy time.
 */
function validateBedrockModels(
  models: BedrockModelConfig[],
  env: Environment,
  validProviders: readonly string[]
): void {
  if (models.length === 0) {
    throw new Error(`[${env}] bedrockModels must contain at least one model`);
  }
  for (const model of models) {
    if (!model.id || typeof model.id !== 'string') {
      throw new Error(`[${env}] bedrockModels: invalid model id: ${JSON.stringify(model)}`);
    }
    if (!NAMESPACED_MODEL_ID.test(model.id)) {
      throw new Error(
        `[${env}] bedrockModels: model id "${model.id}" must be a namespaced model id ` +
          `(e.g. an inference profile id like "global.anthropic.claude-sonnet-4-6" ` +
          `or a bare In-Region id like "qwen.qwen3-235b-a22b-2507-v1:0")`
      );
    }
    if (!model.name || typeof model.name !== 'string') {
      throw new Error(`[${env}] bedrockModels: missing name for model "${model.id}"`);
    }
    if (!validProviders.includes(model.provider)) {
      throw new Error(
        `[${env}] bedrockModels: invalid provider "${model.provider}" for model "${model.id}". Must be one of: ${validProviders.join(', ')}`
      );
    }
    if (model.region !== undefined && !AWS_REGION_TOKEN.test(model.region)) {
      throw new Error(
        `[${env}] bedrockModels: invalid region "${model.region}" for model "${model.id}". ` +
          `Must be a lowercase AWS region token (e.g. "us-east-1", "ap-northeast-1").`
      );
    }
  }
}

/**
 * Test-only wrapper around the private validateBedrockModels(). Lets unit tests
 * assert validation behavior (e.g. region-pin format) without going through the
 * full getEnvironmentConfig() path. Not used by production code.
 *
 * @param validProviders required provider allowlist. Callers pass it explicitly
 *   (rather than a hardcoded default here) so this file holds NO second copy of
 *   the provider list — the test decides which allowlist it is asserting against.
 */
export function validateBedrockModelsForTest(
  models: BedrockModelConfig[],
  validProviders: readonly string[]
): void {
  validateBedrockModels(models, 'default', validProviders);
}

/**
 * Generate default resource prefix from environment name
 * @param env Environment name
 * @returns Resource prefix (e.g., 'moca', 'mocadev', 'mocapr123')
 */
function getDefaultResourcePrefix(env: Environment): string {
  if (env === 'default') {
    return BASE_PREFIX;
  }
  // Remove hyphens for PR environments (pr-123 -> pr123)
  return `${BASE_PREFIX}${env.replace(/-/g, '')}`;
}

/**
 * Apply default values to partial configuration
 * @param env Environment name (derived from object key)
 * @param input Partial environment configuration input
 * @returns Full configuration with all defaults applied
 */
function resolveConfig(
  env: Environment,
  input: EnvironmentConfigInput,
  catalog: ModelCatalog
): EnvironmentConfig {
  // Per-env override wins; otherwise use the default model list derived from
  // @moca/core (the single source), not a hand-maintained copy.
  const bedrockModels = input.bedrockModels ?? [...catalog.defaultModels];
  validateBedrockModels(bedrockModels, env, catalog.providers);
  validateCognitoDomainPrefix(input.cognitoDomainPrefix, env);

  return {
    // Spread input first so optional properties are automatically passed through.
    // Adding a new optional property to EnvironmentConfig no longer requires
    // updating this function — only properties with defaults need explicit entries below.
    ...input,
    // Required properties (derived or with defaults)
    env,
    resourcePrefix: input.resourcePrefix ?? getDefaultResourcePrefix(env),
    deletionProtection: input.deletionProtection ?? DEFAULT_CONFIG.deletionProtection,
    corsAllowedOrigins: input.corsAllowedOrigins ?? DEFAULT_CONFIG.corsAllowedOrigins,
    memoryExpirationDays: input.memoryExpirationDays ?? DEFAULT_CONFIG.memoryExpirationDays,
    s3RemovalPolicy: input.s3RemovalPolicy ?? DEFAULT_CONFIG.s3RemovalPolicy,
    s3AutoDeleteObjects: input.s3AutoDeleteObjects ?? DEFAULT_CONFIG.s3AutoDeleteObjects,
    cognitoDeletionProtection:
      input.cognitoDeletionProtection ?? DEFAULT_CONFIG.cognitoDeletionProtection,
    // Narrowed to non-null by validateCognitoDomainPrefix above.
    cognitoDomainPrefix: input.cognitoDomainPrefix!,
    logRetentionDays: input.logRetentionDays ?? DEFAULT_CONFIG.logRetentionDays,
    tavilyApiKeySecretName: input.tavilyApiKeySecretName ?? DEFAULT_CONFIG.tavilyApiKeySecretName,
    githubTokenSecretName: input.githubTokenSecretName ?? DEFAULT_CONFIG.githubTokenSecretName,
    githubWebhookSecretName:
      input.githubWebhookSecretName ?? DEFAULT_CONFIG.githubWebhookSecretName,
    cloudFrontGeoRestriction:
      input.cloudFrontGeoRestriction ?? DEFAULT_CONFIG.cloudFrontGeoRestriction,
    bedrockModels,
  };
}

/**
 * Generate PR environment configuration dynamically
 * @param env PR environment name (e.g., pr-123)
 * @returns PR environment configuration input
 */
function getPrEnvironmentConfig(env: string): EnvironmentConfigInput {
  const prNumber = env.replace('pr-', '');

  // Validate PR number
  if (!/^\d+$/.test(prNumber)) {
    throw new Error(`Invalid PR environment name: ${env}. Expected format: pr-{number}`);
  }

  // Auto-generate cognitoDomainPrefix as `moca-pr-{n}-{account4}`.
  // CDK_DEFAULT_ACCOUNT is set by cdk CLI via AWS credentials; require it here
  // so PR stacks can't be synthesized in an environment-agnostic mode that would
  // produce a "moca-pr-123-undefined" prefix.
  const account = process.env.CDK_DEFAULT_ACCOUNT;
  if (!account || !/^\d{12}$/.test(account)) {
    throw new Error(
      `[${env}] CDK_DEFAULT_ACCOUNT must be a 12-digit AWS account ID, got "${account ?? ''}". ` +
        'Run cdk with valid AWS credentials so PR environments can generate a unique Cognito domain prefix.'
    );
  }
  const accountSuffix = account.slice(-4);

  return {
    // resourcePrefix is auto-generated as 'mocapr123' from env 'pr-123'
    cognitoDomainPrefix: `moca-pr-${prNumber}-${accountSuffix}`,
    memoryExpirationDays: 7, // Short retention for PR environments
    logRetentionDays: 3, // Short retention for PR environments
    tavilyApiKeySecretName: 'agentcore/dev/tavily-api-key', // Use dev secrets
    githubTokenSecretName: 'agentcore/dev/github-token', // Use dev secrets
    allowedSignUpEmailDomains: ['amazon.com', 'amazon.co.jp'],
  };
}

/**
 * Get environment configuration with defaults applied.
 *
 * @param env Environment name (default, dev, stg, prd, or pr-{number})
 * @param catalog Model catalog loaded from @moca/core (see {@link buildModelCatalog}).
 *   Passing it explicitly makes "load core before resolving config" a
 *   compile-time requirement — the composition root (bin/app.ts) awaits the
 *   dynamic import of core and hands the catalog in.
 * @returns Full environment configuration with all defaults applied
 */
export function getEnvironmentConfig(env: Environment, catalog: ModelCatalog): EnvironmentConfig {
  // Check if it's a PR environment (e.g., pr-123)
  if (env.startsWith('pr-')) {
    return resolveConfig(env, getPrEnvironmentConfig(env), catalog);
  }

  const config = environments[env];
  if (!config) {
    throw new Error(
      `Unknown environment: ${env}. Valid values are: default, dev, stg, prd, or pr-{number}`
    );
  }
  return resolveConfig(env, config, catalog);
}
