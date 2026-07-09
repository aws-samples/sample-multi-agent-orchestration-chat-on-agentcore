import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

/**
 * Environment variable schema definition
 */
const envSchema = z.object({
  // Runtime environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // AWS Configuration
  AWS_REGION: z.string().default('us-east-1'),
  AWS_PROFILE: z.string().optional(),

  // AgentCore Gateway Configuration
  AGENTCORE_GATEWAY_ENDPOINT: z.url(),

  // Bedrock Configuration
  BEDROCK_MODEL_ID: z.string().default('global.anthropic.claude-sonnet-4-6'),
  BEDROCK_REGION: z.string().default('us-east-1'),

  // AgentCore Memory Configuration
  AGENTCORE_MEMORY_ID: z.string().optional(),
  /**
   * Semantic memory strategyId resolved at deploy time by CDK
   * (AgentCoreMemory.semanticStrategyId). Required for long-term memory
   * retrieval — the agent uses it to compose the namespace
   * `/strategies/{strategyId}/actors/{actorId}`.
   */
  AGENTCORE_SEMANTIC_STRATEGY_ID: z.string().optional(),

  // User-scoped credentials via Cognito Identity Pool.
  // IDENTITY_POOL_ID and COGNITO_USER_POOL_ID replace the former STS AssumeRole approach.
  // Required in all environments. Run `npm run setup-env` to populate these from CloudFormation outputs.
  IDENTITY_POOL_ID: z.string().min(1),
  COGNITO_USER_POOL_ID: z.string().min(1),
  COGNITO_USER_POOL_CLIENT_ID: z.string().min(1),
  COGNITO_MACHINE_USER_CLIENT_ID: z.string().optional(),
  USER_STORAGE_BUCKET_NAME: z.string().optional(),
  SESSIONS_TABLE_NAME: z.string().optional(),

  // AppSync / real-time communication
  APPSYNC_HTTP_ENDPOINT: z.string().optional(),

  // AgentCore Runtime self-identification.
  // Injected by the AgentCore Runtime platform into each container; absent in
  // local development. Used by `services/session-terminator` to extract this
  // container's own Runtime ARN (between `/runtimes/` and `/invocations`).
  AGENTCORE_RUNTIME_URL: z.string().optional(),

  // Backend API
  // Required in all environments. Run `npm run setup-env` to populate from CloudFormation outputs.
  BACKEND_API_URL: z.url(),

  // HTTP server
  PORT: z.coerce.number().int().positive().default(8080),

  // CORS
  // Stored as comma-separated string; transformed to string[] for direct consumption.
  CORS_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(',').map((s) => s.trim()) : ['*'])),

  // Allowed working directories for execute_command tool (comma-separated)
  ALLOWED_WORKING_DIRS: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(',').map((s) => s.trim()) : [])),

  // GitHub Token Broker Lambda ARN.
  // `startup.sh` invokes this Lambda once at container boot to retrieve the
  // GitHub PAT and hand it to `gh auth login`. After auth it unsets this env
  // var so the agent process cannot see or re-invoke the broker.
  // The agent code itself does not read this value; schema entry exists only to
  // document the contract with startup.sh and keep env parsing strict.
  GITHUB_TOKEN_BROKER_LAMBDA_ARN: z.string().optional(),

  // Debug Configuration
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DEBUG_MCP: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),

  // Conversation Management Configuration
  // Must be an even number ≥ 2 to guarantee valid user/assistant message alternation
  // after SlidingWindowConversationManager truncation.
  CONVERSATION_WINDOW_SIZE: z.coerce
    .number()
    .int({ message: 'CONVERSATION_WINDOW_SIZE must be an integer' })
    .min(2, { message: 'CONVERSATION_WINDOW_SIZE must be at least 2' })
    .refine((val) => val % 2 === 0, {
      message:
        'CONVERSATION_WINDOW_SIZE must be an even number to maintain user/assistant message ordering',
    })
    .default(40),

  // Prompt Caching Configuration
  ENABLE_PROMPT_CACHING: z
    .string()
    .default('true')
    .transform((val) => val === 'true'),
});

/**
 * Configuration type definition
 */
export type Config = z.infer<typeof envSchema>;

/**
 * Parse and validate environment variables
 */
function parseEnv(): Config {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.issues.map((issue) => issue.path.join('.')).join(', ');
      throw new Error(`Required environment variables are not set: ${missingVars}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Application configuration
 */
export const config = parseEnv();

/**
 * Workspace directory
 * Default working directory for Agent file operations
 */
export const WORKSPACE_DIRECTORY = '/tmp/ws';

/**
 * Subdirectory of the active workspace holding skill definitions
 * (`{workspaceDir}/.skills/<skill-name>/SKILL.md`).
 */
export const SKILLS_DIR_NAME = '.skills';

// Re-export Bedrock model utilities
export { createBedrockModel, type BedrockModelOptions } from './bedrock.js';
