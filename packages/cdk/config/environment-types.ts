/**
 * Environment configuration type definitions
 */

import * as cdk from 'aws-cdk-lib';

/**
 * Environment name
 */
export type Environment = 'default' | 'dev' | 'stg' | 'prd' | string; // Allow dynamic PR environments

/**
 * Model provider + non-Converse endpoint unions.
 *
 * These MIRROR @moca/core's `Provider` / `BedrockEndpoint`, re-declared here
 * rather than imported because @moca/core is ESM and this file is compiled as
 * CommonJS by CDK's ts-node/ts-jest (a type-only import of an ESM module from
 * CJS under Node16 requires a `resolution-mode` attribute and jest cannot
 * resolve the package at all). Drift is guarded at RUNTIME instead: the actual
 * provider allowlist and default model list flow from core via
 * buildModelCatalog() and are passed into getEnvironmentConfig(), so a mismatch
 * surfaces at synth time, not from these compile-time aliases.
 */
export type Provider = 'Anthropic' | 'Amazon' | 'Qwen' | 'OpenAI';
export type BedrockEndpoint = 'bedrock-openai' | 'mantle';

/**
 * Bedrock model configuration for frontend model selector
 */
export interface BedrockModelConfig {
  /**
   * Full model ID. Either a cross-region inference profile ID
   * (e.g. 'global.anthropic.claude-sonnet-4-6') or a bare, namespaced
   * In-Region foundation-model ID (e.g. 'qwen.qwen3-235b-a22b-2507-v1:0').
   */
  id: string;
  /** Display name (e.g., 'Claude Sonnet 4.6') */
  name: string;
  /** Provider name (from @moca/core's Provider union — the single source). */
  provider: Provider;
  /**
   * Optional invocation-region pin.
   *
   * Most models are invoked in the deployment region. Some must be invoked in a
   * specific region (an In-Region-only model not yet rolled out everywhere, or a
   * model whose account-level prerequisite — e.g. Bedrock Data Retention mode —
   * is only enabled in certain regions). When set, the agent invokes this model
   * in `region` (via @moca/core getModelRegion), and deriveBedrockIamResources()
   * scopes the model's inference-profile IAM ARN to the SAME region so the call
   * is authorized. Omit for models invoked in the deployment region (the common
   * case).
   *
   * For the default model list this is DERIVED from the matching
   * BEDROCK_MODEL_DEFINITIONS entry (packages/libs/core/src/bedrock-models.ts)
   * via buildModelCatalog(), so it cannot drift. This field only needs setting
   * on a hand-authored per-environment `bedrockModels` override in
   * environments.ts, where it must match that model's core region pin.
   */
  region?: string;
  /**
   * Non-Converse Bedrock endpoint (transport) this model is invoked through, if
   * any. Drives the task-role IAM: the two endpoints use DIFFERENT AWS services.
   *
   *   - `'bedrock-openai'` — standard runtime host
   *     (`bedrock-runtime.{region}.amazonaws.com/openai/v1`, Chat Completions).
   *     Authorized by the standard `bedrock:InvokeModel*` foundation-model ARN +
   *     `bedrock:CallWithBearerToken`. Today: gpt-oss.
   *   - `'mantle'` — Bedrock Mantle host
   *     (`bedrock-mantle.{region}.api.aws/openai/v1`, Responses API). Authorized
   *     by the **`bedrock-mantle:`** service actions (`CreateInference` / `Get*`
   *     / `List*` on `project/*` + `CallWithBearerToken`), NOT `bedrock:`. Today:
   *     gpt-5.x (Mantle also hosts non-OpenAI vendors — vendor-neutral name).
   *
   * Type is @moca/core's BedrockEndpoint (the single source). When the default
   * model list is derived from BEDROCK_MODEL_DEFINITIONS this cannot drift; a
   * hand-authored per-env override still gets compile-time checking.
   * Omit for Converse-API models.
   */
  endpoint?: BedrockEndpoint;
}

/**
 * Environment-specific configuration interface
 * Used throughout the stack - all core properties are required (defaults applied)
 */
export interface EnvironmentConfig {
  /**
   * Environment name
   */
  env: Environment;

  /**
   * Resource name prefix
   * Used as common prefix for all resources (Gateway, Cognito, S3, API, etc.)
   * Must contain only lowercase letters and numbers (no hyphens or underscores)
   * Examples: 'moca', 'mocadev', 'mocastg', 'mocaprd'
   */
  resourcePrefix: string;

  /**
   * AWS Account ID (optional)
   * Uses CDK_DEFAULT_ACCOUNT if not specified
   */
  awsAccount?: string;

  /**
   * Stack deletion protection
   */
  deletionProtection: boolean;

  /**
   * CORS allowed origins
   */
  corsAllowedOrigins: string[];

  /**
   * Memory expiration (days)
   */
  memoryExpirationDays: number;

  /**
   * S3 removal policy
   */
  s3RemovalPolicy: cdk.RemovalPolicy;

  /**
   * S3 auto delete objects (only effective when RemovalPolicy is DESTROY)
   */
  s3AutoDeleteObjects: boolean;

  /**
   * Cognito deletion protection
   */
  cognitoDeletionProtection: boolean;

  /**
   * Cognito User Pool Domain prefix.
   *
   * This prefix becomes part of the managed login URL:
   *   https://{cognitoDomainPrefix}.auth.{region}.amazoncognito.com/oauth2/token
   *
   * Cognito domain prefixes share a GLOBAL namespace across all AWS accounts
   * and regions, so pick a value that is unlikely to collide with other users.
   * A common convention is to include an organization/team identifier and an
   * environment suffix (e.g. "acme-moca-dev").
   *
   * Requirements (enforced by validateCognitoDomainPrefix):
   *   - 3-63 characters
   *   - Lowercase alphanumeric and hyphens only
   *   - Must not start with "aws", "amazon", or "cognito"
   *   - Must not start or end with a hyphen
   *
   * Changing this value on an existing deployment triggers a Replacement of
   * AWS::Cognito::UserPoolDomain (CFN Update requires: Replacement) and may
   * fail if the old prefix is still attached to the UserPool. In that case,
   * delete the old domain manually before redeploying:
   *   aws cognito-idp delete-user-pool-domain --domain <old-prefix> --user-pool-id <pool-id>
   */
  cognitoDomainPrefix: string;

  /**
   * Lambda function log retention period (days)
   */
  logRetentionDays: number;

  /**
   * Tavily API Key Secret Name (Secrets Manager)
   * Set for production/staging environments to retrieve API key from Secrets Manager
   * NOTE: This is a secret NAME/ID reference, not the actual secret value
   * pragma: allowlist secret
   */
  tavilyApiKeySecretName?: string;

  /**
   * GitHub Token Secret Name (Secrets Manager)
   * Set for environments to retrieve GitHub token from Secrets Manager
   * Used for gh CLI authentication
   * NOTE: This is a secret NAME/ID reference, not the actual secret value
   * pragma: allowlist secret
   */
  githubTokenSecretName?: string;

  /**
   * Allowed email domains for sign-up (optional)
   * If set, only emails from these domains can sign up
   * Example: ['amazon.com', 'amazon.jp']
   */
  allowedSignUpEmailDomains?: string[];

  /**
   * Custom domain configuration for frontend (optional)
   * If set, CloudFront distribution will use custom domain with ACM certificate
   */
  customDomain?: {
    /**
     * Hostname for the website (e.g., 'genai')
     * A record will be created by CDK
     */
    hostName: string;

    /**
     * Domain name of the public hosted zone (e.g., 'example.com')
     * The hosted zone must exist in the same AWS account
     */
    domainName: string;
  };

  /**
   * Microsoft Graph OAuth2 Credential Provider ARN (optional)
   * Created via AgentCore Identity management console.
   * When set together with microsoftGraphOAuthSecretArn, enables OneDrive OpenAPI target.
   * Format: arn:aws:bedrock-agentcore:{region}:{account}:token-vault/{id}/oauth2credentialprovider/{name}
   */
  microsoftGraphOAuthProviderArn?: string;

  /**
   * Microsoft Graph OAuth2 Secret ARN (optional)
   * The Secrets Manager secret ARN auto-generated when creating the OAuth2 credential provider.
   * Required together with microsoftGraphOAuthProviderArn to enable OneDrive OpenAPI target.
   * Format: arn:aws:secretsmanager:{region}:{account}:secret:{name}
   * NOTE: This is a secret ARN reference, not the actual secret value
   * pragma: allowlist secret
   */
  microsoftGraphOAuthSecretArn?: string;

  /**
   * GitHub Webhook Secret Name (Secrets Manager)
   * Used for verifying GitHub webhook HMAC-SHA256 signatures
   * NOTE: This is a secret NAME/ID reference, not the actual secret value
   * pragma: allowlist secret
   */
  githubWebhookSecretName?: string;

  /**
   * Available Bedrock models for frontend model selector (optional)
   * Each model ID should include the cross-region inference profile prefix
   * (e.g., 'global.', 'jp.', 'us.', 'eu.', 'apac.')
   * @default The catalog derived from @moca/core's BEDROCK_MODEL_DEFINITIONS
   *   (packages/libs/core/src/bedrock-models.ts), loaded via buildModelCatalog()
   *   in bin/app.ts; Claude Opus 4.8 is the default-selected model. That file is
   *   the authoritative set and grows as new models are added — set this field
   *   only to override the catalog for a single environment.
   */
  bedrockModels?: BedrockModelConfig[];

  /**
   * CloudFront geo restriction - allowlist of ISO 3166-1 alpha-2 country codes (optional)
   * When set, only requests from these countries are allowed.
   * Example: ['JP', 'US', 'GB']
   * @default ['JP', 'US']
   */
  cloudFrontGeoRestriction?: string[];

  /**
   * Event rules configuration (optional)
   * Predefined EventBridge rules that users can subscribe to for triggers
   */
  eventRules?: EventRuleConfig[];

  /**
   * Athena source data S3 locations (optional, opt-in)
   * When set, the Athena Tools Lambda target is deployed and IAM read access is scoped
   * to only these S3 locations (no wildcard Resource:*).
   * When NOT set, the Athena Tools Lambda target is NOT deployed at all.
   * Example:
   *   [
   *     { bucket: 'my-data-lake-bucket' },
   *     { bucket: 'analytics-data-123456789012-ap-northeast-1', prefix: 'analytics/meti_data/' },
   *   ]
   */
  athenaSourceBuckets?: AthenaS3Source[];

  /**
   * Amazon Bedrock Knowledge Base IDs to enable KB search tools (optional, opt-in)
   * When set, the Knowledge Base Tools Lambda target is deployed and IAM bedrock:Retrieve
   * access is scoped to only these Knowledge Base ARNs.
   * When NOT set, the Knowledge Base Tools Lambda target is NOT deployed at all.
   */
  knowledgeBaseIds?: string[];
}

/**
 * Input type for defining environment configurations
 * All properties are optional - `env` is derived from the object key,
 * `resourcePrefix` is auto-generated from env if not specified
 * Used only in environments.ts for configuration definition
 */
export type EnvironmentConfigInput = Partial<Omit<EnvironmentConfig, 'env'>>;

/**
 * Event rule configuration
 * Defines EventBridge rules that trigger Lambda when events match the pattern
 */
export interface EventRuleConfig {
  /**
   * Unique identifier (e.g., "s3-upload", "github-push")
   */
  id: string;

  /**
   * Display name (e.g., "S3 File Upload")
   */
  name: string;

  /**
   * Description
   */
  description: string;

  /**
   * EventBridge event pattern
   * Matches events to trigger the Lambda function
   */
  eventPattern: {
    /**
     * Event source (e.g., ["aws.s3"], ["com.github"])
     */
    source: string[];

    /**
     * Event detail type (e.g., ["Object Created"], ["Push"])
     */
    detailType: string[];

    /**
     * Optional detail filters
     * Example: { bucket: { name: ["my-bucket"] } }
     */
    detail?: Record<string, unknown>;
  };

  /**
   * Icon name for frontend display (optional)
   */
  icon?: string;

  /**
   * Whether this rule is enabled
   */
  enabled: boolean;
}

/**
 * Athena source S3 location
 * Specifies an S3 bucket (and optional prefix) that Athena Tools Lambda is allowed to read.
 */
export interface AthenaS3Source {
  /**
   * S3 bucket name
   * Example: 'analytics-data-988417841316-ap-northeast-1'
   */
  bucket: string;

  /**
   * S3 key prefix to restrict access to a specific folder (optional)
   * Must end with '/' to denote a folder.
   * When omitted, the entire bucket is accessible.
   * Example: 'analytics/meti_data_business_potential/'
   */
  prefix?: string;
}
