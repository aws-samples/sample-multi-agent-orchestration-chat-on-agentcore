/**
 * Backend API Configuration
 * Manage environment variables and application settings
 */

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { logger } from '../libs/logger/index.js';

// Load environment variables
loadEnv();

/**
 * Environment variable schema definition
 *
 * The parsed schema object is exported directly as `config` so that every
 * lookup uses the same upper-case key as the underlying env var (e.g.
 * `config.AGENTCORE_MEMORY_ID`). This mirrors the pattern used by
 * `packages/agent/src/config/index.ts` and avoids maintaining a parallel
 * rename map.
 */
const envSchema = z.object({
  // Server configuration
  PORT: z.string().default('3000').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Cognito configuration (required for JWT verification)
  COGNITO_USER_POOL_ID: z.string({
    error: 'COGNITO_USER_POOL_ID is required for JWT verification',
  }),
  COGNITO_REGION: z.string({
    error: 'COGNITO_REGION is required for JWT verification',
  }),
  /**
   * Allowed Cognito User Pool App Client IDs for JWT verification.
   *
   * The verifier enforces an explicit `aud` / `client_id` allow-list so that
   * tokens minted for a different App Client on the SAME user pool are
   * rejected. Previously this was a single optional `COGNITO_CLIENT_ID` which
   * defaulted to `null` in `aws-jwt-verify` — meaning any client_id was
   * accepted. That was the same category of weakness as the agent-side H1
   * finding.
   *
   * Frontend client is always required; machine-user client is optional and
   * only needs to be set when Client-Credentials-Flow callers are expected on
   * this deployment.
   */
  COGNITO_USER_POOL_CLIENT_ID: z.string({
    error: 'COGNITO_USER_POOL_CLIENT_ID is required for JWT aud / client_id verification',
  }),
  COGNITO_MACHINE_USER_CLIENT_ID: z.string().optional(),

  // Cognito Identity Pool (required for per-user credential exchange)
  IDENTITY_POOL_ID: z.string({
    error: 'IDENTITY_POOL_ID is required for per-user credentials',
  }),

  /**
   * Developer Authenticated Identities provider name registered on the Cognito
   * Identity Pool. When set, every UserPool ID Token seen by the backend will
   * trigger a fire-and-forget `GetOpenIdTokenForDeveloperIdentity` that links
   * the developer login `{ DEVELOPER_PROVIDER_NAME: userPoolSub }` to the
   * user's identityId. The same identityId can then be resolved by Trigger
   * Lambda for event-driven invocations — guaranteeing a single identityId
   * (and therefore a single S3 prefix / DynamoDB partition key) per user
   * regardless of whether the request came from the frontend or from an event.
   *
   * Left optional so local development without Identity Pool plumbing still
   * boots; when unset, link-on-login is skipped and event-driven flows will
   * create a second Identity Pool identity on first event fire.
   */
  DEVELOPER_PROVIDER_NAME: z.string().optional(),

  // CORS configuration — stored raw; split into string[] via `corsAllowedOrigins`
  CORS_ALLOWED_ORIGINS: z.string().default('*'),

  // AgentCore Memory configuration (required)
  AGENTCORE_MEMORY_ID: z.string({
    error: 'AGENTCORE_MEMORY_ID is required for memory features',
  }),
  AGENTCORE_SEMANTIC_STRATEGY_ID: z.string({
    error: 'AGENTCORE_SEMANTIC_STRATEGY_ID is required for memory features',
  }),
  AWS_REGION: z.string().default('us-east-1'),

  // AgentCore Gateway configuration (required)
  AGENTCORE_GATEWAY_ENDPOINT: z.string({
    error: 'AGENTCORE_GATEWAY_ENDPOINT is required for MCP tool integration',
  }),

  // User Storage configuration (required)
  USER_STORAGE_BUCKET_NAME: z.string({
    error: 'USER_STORAGE_BUCKET_NAME is required for user file storage',
  }),
  /**
   * STS AssumeRole target for per-user S3 access via session policy.
   * Set by CDK to the `BackendUserScopedS3Role` ARN. When absent, s3-storage
   * falls back to the Lambda execution role (useful for local development
   * without Identity Pool plumbing).
   */
  USER_SCOPED_ROLE_ARN: z.string().optional(),

  // Agents Table configuration (required)
  AGENTS_TABLE_NAME: z.string({
    error: 'AGENTS_TABLE_NAME is required for agent management',
  }),

  // Sessions Table configuration (required)
  SESSIONS_TABLE_NAME: z.string({
    error: 'SESSIONS_TABLE_NAME is required for session management',
  }),

  // SSM Parameter Store prefix for MCP env values (required)
  SSM_PARAMETER_PREFIX: z.string({
    error: 'SSM_PARAMETER_PREFIX is required for secure MCP env storage',
  }),

  // Event-driven triggers (required for /api/triggers routes)
  TRIGGERS_TABLE_NAME: z.string({
    error: 'TRIGGERS_TABLE_NAME is required for trigger management',
  }),
  TRIGGER_LAMBDA_ARN: z.string({
    error: 'TRIGGER_LAMBDA_ARN is required for trigger scheduling',
  }),
  SCHEDULER_ROLE_ARN: z.string({
    error: 'SCHEDULER_ROLE_ARN is required for EventBridge Scheduler',
  }),
  SCHEDULE_GROUP_NAME: z.string().default('default'),
  /**
   * JSON-encoded array of event source rule names.
   * Defaults to an empty array when event-driven automation is not wired.
   */
  EVENT_SOURCES_CONFIG: z.string().default('[]'),

  // GitHub Webhook (optional — only required when the webhook endpoint is enabled)
  GITHUB_WEBHOOK_SECRET_NAME: z.string().optional(),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

/**
 * Validate and parse environment variables
 */
function parseEnv(): z.infer<typeof envSchema> {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    logger.error({ err: error }, 'Invalid environment variable configuration');
    process.exit(1);
  }
}

/**
 * Fully-validated application configuration. Each field name matches the
 * underlying environment variable exactly (e.g. `config.AGENTCORE_MEMORY_ID`).
 */
export const config = parseEnv();

/** Convenience: `CORS_ALLOWED_ORIGINS` parsed into a list. */
export const corsAllowedOrigins: string[] = config.CORS_ALLOWED_ORIGINS.split(',').map((o) =>
  o.trim()
);

/** Convenience flags derived from `NODE_ENV`. */
export const isDevelopment = config.NODE_ENV === 'development';

logger.info(
  {
    port: config.PORT,
    nodeEnv: config.NODE_ENV,
    hasCognitoUserPoolId: !!config.COGNITO_USER_POOL_ID,
    hasCognitoUserPoolClientId: !!config.COGNITO_USER_POOL_CLIENT_ID,
    hasCognitoMachineUserClientId: !!config.COGNITO_MACHINE_USER_CLIENT_ID,
    corsOrigins: corsAllowedOrigins,
  },
  'Backend API configuration loaded'
);
