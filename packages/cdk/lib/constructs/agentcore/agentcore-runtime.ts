/**
 * Amazon Bedrock AgentCore Runtime Construct
 * CDK Construct for deploying Strands Agent to AgentCore Runtime
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { RuntimeAuthorizerConfiguration } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { ContainerImageBuild } from '@cdklabs/deploy-time-build';
import { Construct } from 'constructs';
import { CognitoAuth } from '../auth';
import { AgentCoreGateway } from './agentcore-gateway';
import { BedrockModelConfig, deriveBedrockIamResources } from '../../../config';
import * as path from 'path';

/**
 * Get project root directory from CDK package
 * CDK is always run from packages/cdk/, so go 2 levels up to reach repo root.
 */
const PROJECT_ROOT = path.resolve(process.cwd(), '../..');

export interface AgentCoreRuntimeProps {
  /**
   * Runtime name
   */
  readonly runtimeName: string;

  /**
   * Runtime description
   */
  readonly description?: string;

  /**
   * Agent code path
   * @default '../agent'
   */
  readonly agentCodePath?: string;

  /**
   * AWS region
   * @default us-east-1
   */
  readonly region?: string;

  /**
   * Authentication type (optional)
   * @default iam (IAM SigV4 authentication)
   */
  readonly authType?: 'iam' | 'jwt';

  /**
   * Cognito authentication settings (required when authType is 'jwt')
   * Uses externally created CognitoAuth
   */
  readonly cognitoAuth?: CognitoAuth;

  /**
   * AgentCore Gateway (for JWT propagation)
   * Sets Gateway endpoint as environment variable for Runtime
   */
  readonly gateway?: AgentCoreGateway;

  /**
   * CORS allowed origin URLs
   * e.g., Frontend CloudFront URL
   */
  readonly corsAllowedOrigins?: string;

  /**
   * AgentCore Memory configuration (optional)
   */
  readonly memory?: {
    readonly memoryId: string;
    readonly enabled?: boolean;
    /**
     * Deploy-time-resolved semantic memory strategy id (e.g.
     * `semantic_memory_strategy-Zm6Brc4FaH`). Required for long-term memory
     * retrieval (`RetrieveMemoryRecords`) to build the namespace. When
     * omitted, long-term memory features will be disabled at runtime.
     */
    readonly semanticStrategyId?: string;
  };

  /**
   * GitHub Token Broker Lambda ARN (optional)
   * When set, startup.sh invokes this Lambda to fetch the GitHub token for gh CLI auth.
   * Runtime execution role receives `lambda:InvokeFunction` scoped to this ARN only;
   * it is NOT granted `secretsmanager:GetSecretValue`.
   */
  readonly githubTokenBrokerLambdaArn?: string;

  /**
   * User Storage bucket name (optional)
   * Required for using S3 storage tools
   */
  readonly userStorageBucketName?: string;

  /**
   * Sessions Table name (optional)
   * Required for session management
   */
  readonly sessionsTableName?: string;

  /**
   * Cognito Identity Pool ID (optional)
   * Required for user-scoped S3/DynamoDB access via Identity Pool credentials.
   * When set, the Runtime execution role gains cognito-identity:GetId and
   * cognito-identity:GetCredentialsForIdentity permissions to exchange an
   * incoming Cognito ID Token for per-user temporary credentials.
   */
  readonly identityPoolId?: string;

  /**
   * Cognito User Pool ID (optional)
   * Required when identityPoolId is set — used as the Logins key when calling
   * GetId / GetCredentialsForIdentity against the Identity Pool.
   */
  readonly cognitoUserPoolId?: string;

  /**
   * Backend API URL (optional)
   * Required for retrieving agent information with call_agent tool
   * Example: https://api.example.com
   */
  readonly backendApiUrl?: string;

  /**
   * AppSync Events HTTP Endpoint (optional)
   * Used for real-time message delivery
   */
  readonly appsyncHttpEndpoint?: string;

  /**
   * Bedrock models allowed for invocation (from bedrockModels environment config).
   * Used to derive scoped IAM resource ARNs for InvokeModel permissions.
   * Nova Reel async-invoke is excluded — handled by Gateway Target Lambda only.
   */
  readonly bedrockModels: BedrockModelConfig[];
}

/**
 * Amazon Bedrock AgentCore Runtime Construct
 */
export class AgentCoreRuntime extends Construct {
  /**
   * Created AgentCore Runtime
   */
  public readonly runtime: agentcore.Runtime;

  /**
   * Runtime ARN
   */
  public readonly runtimeArn: string;

  /**
   * Runtime ID
   */
  public readonly runtimeId: string;

  constructor(scope: Construct, id: string, props: AgentCoreRuntimeProps) {
    super(scope, id);

    // Build container image using deploy-time-build (CodeBuild)
    // Platform: ARM64 (Amazon Bedrock AgentCore Runtime requires ARM64 architecture)
    // Note: Using CodeBuild eliminates the need for QEMU emulation on x86_64 systems.
    // CodeBuild natively supports ARM64 builds.
    const containerImage = new ContainerImageBuild(this, 'AgentImageBuild', {
      directory: PROJECT_ROOT,
      file: 'docker/agent.Dockerfile',
      platform: Platform.LINUX_ARM64,
      // docker/agent.Dockerfile.dockerignore controls what ships into the
      // image; this narrow exclude keeps CDK's own synth output (cdk.out)
      // and node_modules out of the hash input so synth stays fast and
      // avoids the recursive-self-reference pathology where asset.xxx ends
      // up nested inside its own source tree.
      exclude: ['node_modules', '**/node_modules', 'cdk.out', '**/cdk.out'],
    });

    // Create AgentRuntimeArtifact from ECR repository
    const agentRuntimeArtifact = agentcore.AgentRuntimeArtifact.fromEcrRepository(
      containerImage.repository,
      containerImage.imageTag
    );

    // Authentication configuration
    let authorizerConfiguration: RuntimeAuthorizerConfiguration | undefined;

    if (props.authType === 'jwt') {
      if (!props.cognitoAuth) {
        throw new Error('cognitoAuth is required when using JWT authentication');
      }

      // Configure Cognito authentication using L2 Construct static method
      // Allow both Frontend Client and Machine User Client
      authorizerConfiguration = RuntimeAuthorizerConfiguration.usingCognito(
        props.cognitoAuth.userPool,
        [props.cognitoAuth.userPoolClient, props.cognitoAuth.machineUserClient]
      );

      console.log(
        `Cognito: UserPool=${props.cognitoAuth.userPoolId}, Frontend Client=${props.cognitoAuth.clientId}, Machine User Client=${props.cognitoAuth.machineUserClientId}`
      );
    }

    // Set environment variables
    const environmentVariables: Record<string, string> = {
      AWS_REGION: props.region || 'us-east-1',
      BEDROCK_MODEL_ID: 'global.anthropic.claude-sonnet-4-6',
      BEDROCK_REGION: props.region || 'us-east-1',
      LOG_LEVEL: 'info',
      // Disable the AWS SDK auto-instrumentation in the ADOT JS distro.
      // ADOT's `_adotInjectXrayContextMiddleware` / `_adotExtractSignerCredentials`
      // (see node_modules/@aws/aws-distro-opentelemetry-node-autoinstrumentation/
      // build/src/patches/instrumentation-patch.js:329-401) inject themselves at
      // the AWS SDK v3 middleware stack's `step: 'build'` with `override: true`,
      // which runs *before* SigV4 signing in `step: 'finalizeRequest'`. In our
      // deployment the X-Ray Trace ID header injection ends up not being part
      // of the canonical request used by the SDK's signer (or the case-flip
      // between `x-amzn-trace-id` and `X-Amzn-Trace-Id` desyncs SignedHeaders),
      // and every BedrockAgentCore / S3 SigV4 call returns 403
      // `InvalidSignatureException`. Disabling only the AWS SDK instrumentation
      // keeps the rest of ADOT (HTTP / Express / Strands' own gen_ai spans)
      // intact, so AgentCore Observability still receives Token / Trace List
      // Input/Output data.
      OTEL_NODE_DISABLED_INSTRUMENTATIONS: 'aws-sdk',
    };

    // Set Gateway endpoint (for JWT propagation)
    if (props.gateway) {
      environmentVariables.AGENTCORE_GATEWAY_ENDPOINT = props.gateway.gatewayEndpoint;
    }

    // Set CORS allowed origins
    if (props.corsAllowedOrigins) {
      environmentVariables.CORS_ALLOWED_ORIGINS = props.corsAllowedOrigins;
    }

    // AgentCore Memory configuration
    if (props.memory) {
      environmentVariables.AGENTCORE_MEMORY_ID = props.memory.memoryId;
      if (props.memory.semanticStrategyId) {
        environmentVariables.AGENTCORE_SEMANTIC_STRATEGY_ID = props.memory.semanticStrategyId;
      }
    }

    // Set GitHub Token Broker Lambda ARN (startup.sh invokes it to fetch the token).
    // Secrets Manager access is entirely delegated to the broker Lambda — the Runtime
    // execution role does NOT carry `secretsmanager:GetSecretValue`.
    if (props.githubTokenBrokerLambdaArn) {
      environmentVariables.GITHUB_TOKEN_BROKER_LAMBDA_ARN = props.githubTokenBrokerLambdaArn;
    }

    // Set User Storage bucket name
    if (props.userStorageBucketName) {
      environmentVariables.USER_STORAGE_BUCKET_NAME = props.userStorageBucketName;
    }

    // Set Sessions Table name
    if (props.sessionsTableName) {
      environmentVariables.SESSIONS_TABLE_NAME = props.sessionsTableName;
    }

    // Set Backend API URL
    if (props.backendApiUrl) {
      environmentVariables.BACKEND_API_URL = props.backendApiUrl;
    }

    // Set AppSync Events HTTP Endpoint
    if (props.appsyncHttpEndpoint) {
      environmentVariables.APPSYNC_HTTP_ENDPOINT = props.appsyncHttpEndpoint;
    }

    // AgentCore Observability (OpenTelemetry) configuration.
    //
    // OTEL environment variables (OTEL_RESOURCE_ATTRIBUTES,
    // OTEL_EXPORTER_OTLP_LOGS_HEADERS, etc.) are automatically configured by
    // AgentCore Runtime with the correct log group name and endpoints. The
    // agent container loads ADOT auto-instrumentation via
    // `--require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register`
    // (see docker/agent.Dockerfile + scripts/startup.sh) and registers the
    // exporter as a global OTel TracerProvider/MeterProvider. The Strands
    // SDK's `setupTracer()`/`setupMeter()` (called from packages/agent/src/index.ts)
    // attach to that same global provider so `gen_ai.usage.*` spans flow to
    // CloudWatch GenAI Observability.
    //
    // `AGENT_OBSERVABILITY_ENABLED` is intentionally NOT set: it is an
    // ADOT *Python* distro-only flag (see AWS docs "Get started with
    // AgentCore Observability", Step 3 — non-Runtime-hosted agents). The
    // Node.js ADOT distro and `@strands-agents/sdk@>=1.0` do not read it.

    // Create AgentCore Runtime
    this.runtime = new agentcore.Runtime(this, 'Runtime', {
      runtimeName: props.runtimeName,
      agentRuntimeArtifact: agentRuntimeArtifact,
      description: props.description || `Strands Agent Runtime: ${props.runtimeName}`,
      authorizerConfiguration: authorizerConfiguration,
      environmentVariables: environmentVariables,
      // Enable Authorization header forwarding for JWT authentication
      // and Cognito ID Token forwarding for Identity Pool credential exchange.
      requestHeaderConfiguration: {
        allowlistedHeaders: [
          'Authorization',
          // Cognito ID Token for Identity Pool GetCredentialsForIdentity.
          // The frontend attaches this header so the Runtime can exchange it
          // for per-user temporary credentials (S3/DynamoDB access).
          'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token',
        ],
      },
    });

    const region = props.region || 'us-east-1';
    const account = cdk.Stack.of(this).account;

    // CloudWatch Logs permissions (Statement 1: log-group level)
    this.runtime.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:DescribeLogStreams', 'logs:CreateLogGroup'],
        resources: [
          `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
        ],
      })
    );

    // CloudWatch Logs permissions (Statement 2: all log groups reference)
    this.runtime.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:DescribeLogGroups'],
        resources: [`arn:aws:logs:${region}:${account}:log-group:*`],
      })
    );

    // CloudWatch Logs permissions (Statement 3: log-stream level)
    this.runtime.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
        ],
      })
    );

    // X-Ray tracing permissions
    this.runtime.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
        ],
        resources: ['*'],
      })
    );

    // CloudWatch metrics permissions (conditional)
    this.runtime.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'cloudwatch:namespace': 'bedrock-agentcore',
          },
        },
      })
    );

    // Bedrock model invocation permissions
    // Resources are derived from bedrockModels config (SoT) to restrict access to
    // only the configured models. Nova Reel async-invoke is excluded — it is handled
    // exclusively by the Gateway Target Lambda (NovaReelToolsTarget).
    this.runtime.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BedrockModelInvocation',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: deriveBedrockIamResources(props.bedrockModels, region, account),
      })
    );

    // CodeInterpreter operation permissions
    // Only the four actions actually used at runtime are granted.
    // Customer-managed interpreter ARN is omitted (unused).
    // AWS-managed resource is scoped to the specific "default" interpreter
    // rather than the over-broad wildcard.
    this.runtime.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BedrockAgentCoreCodeInterpreterAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:StartCodeInterpreterSession',
          'bedrock-agentcore:InvokeCodeInterpreter',
          'bedrock-agentcore:StopCodeInterpreterSession',
          'bedrock-agentcore:GetCodeInterpreterSession',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${region}:aws:code-interpreter/aws.codeinterpreter.v1`, // AWS Managed Code Interpreter
        ],
      })
    );

    // Browser operation permissions
    this.runtime.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BedrockAgentCoreBrowserAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateBrowser',
          'bedrock-agentcore:StartBrowserSession',
          'bedrock-agentcore:UpdateBrowserStream',
          'bedrock-agentcore:StopBrowserSession',
          'bedrock-agentcore:GetBrowserSession',
          'bedrock-agentcore:SaveBrowserSessionProfile',
          'bedrock-agentcore:DeleteBrowser',
          'bedrock-agentcore:ListBrowsers',
          'bedrock-agentcore:GetBrowser',
          'bedrock-agentcore:ListBrowserSessions',
          'bedrock-agentcore:ConnectBrowserAutomationStream',
          'bedrock-agentcore:ConnectBrowserLiveViewStream',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${region}:${account}:browser/*`,
          `arn:aws:bedrock-agentcore:${region}:aws:browser/*`, // AWS Managed Browser
        ],
      })
    );

    // GitHub token is fetched via a dedicated broker Lambda — the Runtime
    // execution role is granted `lambda:InvokeFunction` scoped to the broker
    // ARN ONLY and has no `secretsmanager:GetSecretValue`. The matching
    // resource-based policy on the broker (pinned to this role ARN as
    // Principal) is added by `GitHubTokenBroker.allowInvocationBy()` from
    // agentcore-stack.ts.
    if (props.githubTokenBrokerLambdaArn) {
      this.runtime.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'InvokeGitHubTokenBroker',
          effect: iam.Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: [props.githubTokenBrokerLambdaArn],
        })
      );
    }

    // Cognito Identity Pool: user-scoped S3/DynamoDB access via Identity Pool credentials.
    // The Runtime execution role calls GetId + GetCredentialsForIdentity using the
    // Cognito ID Token forwarded in X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token.
    // The resulting credentials are scoped to the Identity Pool Authenticated Role,
    // which restricts access to users/{cognitoUserPoolSub}/* via IAM policy variables.
    // This replaces the former UserScopedRole + STS AssumeRole approach, removing
    // S3/DynamoDB/STS permissions from the execution role entirely.
    if (props.identityPoolId && props.cognitoUserPoolId) {
      // Grant the execution role permission to exchange a Cognito ID Token for
      // temporary credentials via the Identity Pool.
      this.runtime.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'CognitoIdentityPoolGetCredentials',
          effect: iam.Effect.ALLOW,
          actions: ['cognito-identity:GetId', 'cognito-identity:GetCredentialsForIdentity'],
          // Scope to the specific Identity Pool only
          resources: [
            `arn:aws:cognito-identity:${region}:${account}:identitypool/${props.identityPoolId}`,
          ],
        })
      );

      // Pass Identity Pool ID and User Pool ID to the agent process
      environmentVariables.IDENTITY_POOL_ID = props.identityPoolId;
      environmentVariables.COGNITO_USER_POOL_ID = props.cognitoUserPoolId;

      // Runtime-side JWT verification (aws-jwt-verify) needs the exact
      // App Client allow-list to enforce `aud` / `client_id` on both
      // access and ID tokens. We pull these from the shared CognitoAuth
      // construct so the Runtime verifier always matches the App
      // Clients the authorizer is configured with.
      if (props.cognitoAuth) {
        environmentVariables.COGNITO_USER_POOL_CLIENT_ID = props.cognitoAuth.clientId;
        environmentVariables.COGNITO_MACHINE_USER_CLIENT_ID = props.cognitoAuth.machineUserClientId;
      }

      // Note: The developer-auth link (GetOpenIdTokenForDeveloperIdentity) is
      // owned exclusively by the Backend API
      // (packages/backend/src/libs/auth/identity-resolver.ts). The Agent
      // Runtime intentionally does NOT receive this permission, both to
      // minimise blast radius and to prevent the link from being attempted on
      // a developer-auth-token request (which Cognito would reject with
      // InvalidParameterException since the Logins map would contain two
      // developer providers).
    }

    // AppSync Events permissions (for real-time message delivery)
    if (props.appsyncHttpEndpoint) {
      this.runtime.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'AppSyncEventsPublish',
          effect: iam.Effect.ALLOW,
          actions: ['appsync:EventPublish'],
          resources: [`arn:aws:appsync:${region}:${account}:apis/*/channelNamespace/*`],
        })
      );
    }

    // Set properties
    this.runtimeArn = this.runtime.agentRuntimeArn;
    this.runtimeId = this.runtime.agentRuntimeId;
  }
}
