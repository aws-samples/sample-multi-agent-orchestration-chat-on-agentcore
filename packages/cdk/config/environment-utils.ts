/**
 * Environment configuration utilities
 * Contains logic for resolving environment configurations with defaults
 */

import * as cdk from 'aws-cdk-lib';
import type {
  BedrockModelConfig,
  Environment,
  EnvironmentConfig,
  EnvironmentConfigInput,
} from './environment-types';
import { BASE_PREFIX, environments } from './environments';

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
  openAiApiKeySecretName: 'agentcore/default/openai-api-key',
  githubTokenSecretName: 'agentcore/default/github-token',
  githubWebhookSecretName: 'agentcore/default/github-webhook-secret',
  // Default geo restriction: Japan and United States
  // Override per-environment in environments.ts if needed
  cloudFrontGeoRestriction: ['JP', 'US'] as string[],
  /**
   * CDK intentionally does not depend on @moca/core to keep infrastructure free
   * of runtime library dependencies. Keep this list in sync with
   * BEDROCK_MODEL_DEFINITIONS in packages/libs/core/src/bedrock-models.ts —
   * including the optional `region` pin: if a model sets `region` there it must
   * set the SAME `region` here, because deriveBedrockIamResources() uses it to
   * scope the inference-profile IAM ARN. An out-of-sync region pin grants the
   * wrong-region ARN and the agent's invocation fails with AccessDenied.
   * (validateBedrockModels() enforces id/name/provider/region shape at synth time.)
   */
  bedrockModels: [
    {
      // Default model. No account-level prerequisite, so it works out of the box.
      id: 'global.anthropic.claude-opus-4-8',
      name: 'Claude Opus 4.8',
      provider: 'Anthropic',
    },
    {
      // Requires Bedrock Data Retention mode `provider_data_share` in the
      // deployment region — see the registry note in
      // packages/libs/core/src/bedrock-models.ts and the README. No region pin
      // in this OSS default: Fable 5 is invoked in the deploy region, so
      // deriveBedrockIamResources() scopes its inference-profile IAM ARN to the
      // deploy region. If your deploy region cannot enable provider_data_share,
      // pin Fable 5 to a region that has it by overriding bedrockModels (with a
      // `region`) for your environment in environments.ts — and mirror that
      // region in BEDROCK_MODEL_DEFINITIONS so the agent invokes there too.
      id: 'global.anthropic.claude-fable-5',
      name: 'Claude Fable 5',
      provider: 'Anthropic',
    },
    {
      id: 'global.anthropic.claude-opus-4-7',
      name: 'Claude Opus 4.7',
      provider: 'Anthropic',
    },
    {
      id: 'global.anthropic.claude-opus-4-6-v1',
      name: 'Claude Opus 4.6',
      provider: 'Anthropic',
    },
    {
      id: 'global.anthropic.claude-sonnet-5',
      name: 'Claude Sonnet 5',
      provider: 'Anthropic',
    },
    {
      id: 'global.anthropic.claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      provider: 'Anthropic',
    },
    {
      id: 'global.amazon.nova-2-lite-v1:0',
      name: 'Nova Lite 2',
      provider: 'Amazon',
    },
    {
      // In-Region only, bare id (no -v1:0 suffix). maxOutputTokens lives in
      // BEDROCK_MODEL_DEFINITIONS (@moca/core) — CDK config carries id/name/provider only.
      id: 'qwen.qwen3-coder-next',
      name: 'Qwen3 Coder Next',
      provider: 'Qwen',
    },
    {
      // OpenAI GPT-5.5 via Bedrock Mantle (OpenAI-compatible Responses API).
      // Region pin us-east-1: only region hosting gpt-5.5 (404 elsewhere). MUST
      // match BEDROCK_MODEL_DEFINITIONS so the Mantle base URL and this grant
      // target the same region. Bare id → foundation-model ARN only. Requires
      // bedrock:CallWithBearerToken (see BedrockBearerTokenAuth statement).
      id: 'openai.gpt-5.5',
      name: 'GPT-5.5',
      provider: 'OpenAI',
      region: 'us-east-1',
      endpoint: 'mantle',
    },
    {
      // OpenAI GPT-5.4 via Bedrock Mantle. Pinned to us-east-1 to match GPT-5.5
      // (also available in us-west-2).
      id: 'openai.gpt-5.4',
      name: 'GPT-5.4',
      provider: 'OpenAI',
      region: 'us-east-1',
      endpoint: 'mantle',
    },
    {
      // OpenAI GPT-OSS (open-weight) via Bedrock's OpenAI-compatible Chat
      // Completions endpoint. Bare id → foundation-model ARN only (same IAM
      // shape as qwen.*). No region pin: available in ap-northeast-1 and
      // us-east-1/us-east-2/us-west-2, so it is invoked in the deploy region.
      // These invocations additionally require bedrock:CallWithBearerToken — see
      // the BedrockBearerTokenAuth statement added when an OpenAI model is enabled.
      id: 'openai.gpt-oss-120b-1:0',
      name: 'GPT-OSS 120B',
      provider: 'OpenAI',
      endpoint: 'bedrock-openai',
    },
    {
      id: 'openai.gpt-oss-20b-1:0',
      name: 'GPT-OSS 20B',
      provider: 'OpenAI',
      endpoint: 'bedrock-openai',
    },
  ] satisfies BedrockModelConfig[],
};

const VALID_PROVIDERS: readonly string[] = ['Anthropic', 'Amazon', 'Qwen', 'OpenAI'];

/**
 * Whether any configured model uses the `bedrock-openai` endpoint (gpt-oss, via
 * bedrock-runtime `/openai/v1`). These are authorized by the standard
 * `bedrock:InvokeModel*` grant plus `bedrock:CallWithBearerToken` (the
 * bearer-token auth path). Used to gate that CallWithBearerToken statement.
 */
export function hasBedrockOpenAiModel(models: BedrockModelConfig[]): boolean {
  return models.some((m) => m.endpoint === 'bedrock-openai');
}

/**
 * Whether any configured model uses the `mantle` endpoint (gpt-5.x today, via
 * the Bedrock Mantle host). These are authorized by the SEPARATE
 * **`bedrock-mantle:`** service — NOT `bedrock:` — so they need their own IAM
 * statement (CreateInference / Get* / List* on `project/*` +
 * bedrock-mantle:CallWithBearerToken). Used to gate that Mantle statement.
 */
export function hasMantleModel(models: BedrockModelConfig[]): boolean {
  return models.some((m) => m.endpoint === 'mantle');
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
function validateBedrockModels(models: BedrockModelConfig[], env: Environment): void {
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
    if (!VALID_PROVIDERS.includes(model.provider)) {
      throw new Error(
        `[${env}] bedrockModels: invalid provider "${model.provider}" for model "${model.id}". Must be one of: ${VALID_PROVIDERS.join(', ')}`
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
 */
export function validateBedrockModelsForTest(models: BedrockModelConfig[]): void {
  validateBedrockModels(models, 'default');
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
function resolveConfig(env: Environment, input: EnvironmentConfigInput): EnvironmentConfig {
  const bedrockModels = input.bedrockModels ?? DEFAULT_CONFIG.bedrockModels;
  validateBedrockModels(bedrockModels, env);
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
    openAiApiKeySecretName: input.openAiApiKeySecretName ?? DEFAULT_CONFIG.openAiApiKeySecretName,
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
    openAiApiKeySecretName: 'agentcore/dev/openai-api-key', // Use dev secrets
    githubTokenSecretName: 'agentcore/dev/github-token', // Use dev secrets
    allowedSignUpEmailDomains: ['amazon.com', 'amazon.co.jp'],
  };
}

/**
 * Get environment configuration with defaults applied
 * @param env Environment name (default, dev, stg, prd, or pr-{number})
 * @returns Full environment configuration with all defaults applied
 */
export function getEnvironmentConfig(env: Environment): EnvironmentConfig {
  // Check if it's a PR environment (e.g., pr-123)
  if (env.startsWith('pr-')) {
    return resolveConfig(env, getPrEnvironmentConfig(env));
  }

  const config = environments[env];
  if (!config) {
    throw new Error(
      `Unknown environment: ${env}. Valid values are: default, dev, stg, prd, or pr-{number}`
    );
  }
  return resolveConfig(env, config);
}
