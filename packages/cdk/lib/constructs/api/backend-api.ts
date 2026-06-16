import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { ContainerImageBuild } from '@cdklabs/deploy-time-build';
import { Construct } from 'constructs';
import { CognitoAuth } from '../auth';
import { BedrockModelConfig, deriveBedrockIamResources } from '../../../config';
import * as path from 'path';

/**
 * Get project root directory from CDK package
 * CDK is always run from packages/cdk/, so go 2 levels up to reach repo root.
 */
const PROJECT_ROOT = path.resolve(process.cwd(), '../..');

export interface BackendApiProps {
  /**
   * API name
   */
  readonly apiName?: string;

  /**
   * Cognito authentication system
   */
  readonly cognitoAuth: CognitoAuth;

  /**
   * AgentCore Gateway endpoint
   */
  readonly agentcoreGatewayEndpoint: string;

  /**
   * AgentCore Memory ID
   */
  readonly agentcoreMemoryId?: string;

  /**
   * Deploy-time-resolved semantic memory strategy id used by the Backend
   * `/memory/records` routes when building the namespace for
   * `RetrieveMemoryRecords` / `ListMemoryRecords`. Resolved by
   * `AgentCoreMemory.semanticStrategyId` via an `AwsCustomResource` that
   * calls `GetMemory` at deploy time. When omitted, long-term memory API
   * routes will return an error.

   */
  readonly agentcoreSemanticStrategyId?: string;

  /**
   * User Storage bucket name
   */
  readonly userStorageBucketName?: string;

  /**
   * Agents Table name
   */
  readonly agentsTableName?: string;

  /**
   * Sessions Table name
   */
  readonly sessionsTableName?: string;

  /**
   * CORS allowed origins
   */
  readonly corsAllowedOrigins?: string[];

  /**
   * Lambda function timeout (seconds)
   * @default 30
   */
  readonly timeout?: number;

  /**
   * Lambda function memory size (MB)
   * @default 1024
   */
  readonly memorySize?: number;

  /**
   * Lambda function log retention period
   * @default 14 days
   */
  readonly logRetention?: logs.RetentionDays;

  /**
   * Docker image context path
   * @default 'packages/backend'
   */
  readonly dockerContextPath?: string;

  /**
   * Docker image file name
   * @default 'Dockerfile.lambda'
   */
  readonly dockerFileName?: string;

  /**
   * Bedrock models allowed for invocation (from bedrockModels environment config).
   * Used to derive scoped IAM resource ARNs for InvokeModel permissions.
   */
  readonly bedrockModels: BedrockModelConfig[];
}

/**
 * AgentCore Backend API Construct
 *
 * CDK Construct for running Express applications on
 * API Gateway + Lambda using Lambda Web Adapter
 */
export class BackendApi extends Construct {
  /**
   * Lambda function
   */
  public readonly lambdaFunction: lambda.Function;

  /**
   * HTTP API Gateway
   */
  public readonly httpApi: apigatewayv2.HttpApi;

  /**
   * API endpoint URL
   */
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: BackendApiProps) {
    super(scope, id);

    const apiName = props.apiName || 'agentcore-backend-api';
    const corsAllowedOrigins = props.corsAllowedOrigins || ['*'];

    // Create Lambda execution role
    const lambdaExecutionRole = new iam.Role(this, 'BackendApiExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Bedrock model invocation permissions.
    // Resources are derived from bedrockModels config (SoT) to restrict access to only the configured models.
    lambdaExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: deriveBedrockIamResources(
          props.bedrockModels,
          cdk.Stack.of(this).region,
          cdk.Stack.of(this).account
        ),
      })
    );

    // NOTE: Intentionally no AgentCore Memory permissions on this execution
    // role. The Backend forwards each user's Cognito ID Token to
    // `cognito-identity:GetCredentialsForIdentity` and constructs a user-scoped
    // BedrockAgentCoreClient, so Memory calls run under the Identity Pool
    // Authenticated Role and are constrained by the per-user
    // `bedrock-agentcore:actorId` / `bedrock-agentcore:namespace` conditions.
    // The strategy id is resolved at deploy time and delivered via
    // AGENTCORE_SEMANTIC_STRATEGY_ID, so `bedrock-agentcore:GetMemory` is not
    // needed here either.

    // Create CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, 'BackendApiLogGroup', {
      logGroupName: `/aws/lambda/${apiName}-function`,
      retention: props.logRetention || logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Build container image using deploy-time-build (CodeBuild)
    const containerImage = new ContainerImageBuild(this, 'BackendImageBuild', {
      directory: props.dockerContextPath || PROJECT_ROOT,
      file: props.dockerFileName || 'docker/backend.Dockerfile',
      // ARM64 (Graviton2) — ~20% cheaper and on par (or faster) than x86_64 for
      // this pure Node.js + Lambda Web Adapter workload. All runtime deps
      // (node:22-slim, public.ecr.aws/awsguru/aws-lambda-adapter, uv/uvx) are
      // multi-arch and support arm64.
      platform: Platform.LINUX_ARM64,
      // docker/backend.Dockerfile.dockerignore controls what ships into the
      // image; this narrow exclude keeps CDK's own synth output (cdk.out)
      // and node_modules out of the hash input so synth stays fast and
      // avoids the recursive-self-reference pathology where asset.xxx ends
      // up nested inside its own source tree.
      exclude: ['node_modules', '**/node_modules', 'cdk.out', '**/cdk.out'],
    });

    // Create Lambda function (Docker Image Function)
    this.lambdaFunction = new lambda.DockerImageFunction(this, 'BackendApiFunction', {
      functionName: `${apiName}-function`,
      code: containerImage.toLambdaDockerImageCode(),
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(props.timeout || 30),
      memorySize: props.memorySize || 1024,
      role: lambdaExecutionRole,
      logGroup: logGroup, // Use logGroup instead of deprecated logRetention
      // Active X-Ray tracing: samples each invocation (sets `Sampled=1` in the
      // trace header) so the `traceId` (X-Ray Root id) emitted in the Express
      // structured logs ties to a real trace in ServiceLens, and the API
      // Gateway → Lambda hop shows on the service map. CDK grants the required
      // X-Ray write permissions to the execution role automatically. (Downstream
      // AWS SDK subsegments — DynamoDB, Bedrock, ... — would additionally need
      // the aws-xray-sdk/ADOT instrumentation in the app; not enabled here.)
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        // Node.js / Express configuration
        NODE_ENV: 'production',
        PORT: '8080',

        // Cognito / JWT authentication configuration
        COGNITO_USER_POOL_ID: props.cognitoAuth.userPoolId,
        COGNITO_REGION: cdk.Stack.of(this).region,

        // CORS configuration
        CORS_ALLOWED_ORIGINS: corsAllowedOrigins.join(','),

        // AWS / AgentCore configuration
        // AWS_REGION removed as Lambda runtime provides it automatically.
        // AWS_ACCOUNT_ID is NOT auto-injected by Lambda, so pass it explicitly:
        // SchedulerService assembles the persisted EventBridge Schedule ARN from it.
        AWS_ACCOUNT_ID: cdk.Stack.of(this).account,
        AGENTCORE_GATEWAY_ENDPOINT: props.agentcoreGatewayEndpoint,
        AGENTCORE_MEMORY_ID: props.agentcoreMemoryId || '',
        AGENTCORE_SEMANTIC_STRATEGY_ID: props.agentcoreSemanticStrategyId || '',
        USER_STORAGE_BUCKET_NAME: props.userStorageBucketName || '',

        AGENTS_TABLE_NAME: props.agentsTableName || '',
        SESSIONS_TABLE_NAME: props.sessionsTableName || '',

        // Lambda Web Adapter configuration (already set in Dockerfile, but added for safety)
        AWS_LWA_PORT: '8080',
        AWS_LWA_READINESS_CHECK_PATH: '/ping',
        AWS_LWA_INVOKE_MODE: 'BUFFERED',
        AWS_LWA_ASYNC_INIT: 'true',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      description: `AgentCore Backend API - Express.js app running with Lambda Web Adapter`,
    });

    // Create Lambda Integration
    const lambdaIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'BackendApiIntegration',
      this.lambdaFunction,
      {
        payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0,
      }
    );

    // Create CloudWatch Log Group for API Gateway access logs (APIG1)
    const apiAccessLogGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
      logGroupName: `/aws/apigateway/${apiName}-access-logs`,
      retention: props.logRetention || logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create HTTP API Gateway
    this.httpApi = new apigatewayv2.HttpApi(this, 'BackendHttpApi', {
      apiName: apiName,
      description: 'AgentCore Backend HTTP API with Lambda Web Adapter',
      corsPreflight: {
        allowOrigins: corsAllowedOrigins,
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PUT,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: [
          'Content-Type',
          'Authorization',
          // Allow Cognito ID Token header forwarded by the frontend.
          // This header is used by AgentCore Runtime requests for Identity Pool
          // credential exchange. Including it here prevents CORS preflight failures
          // when the same BaseApiClient is used for both Backend API and Runtime calls.
          'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token',
        ],
        maxAge: cdk.Duration.seconds(86400), // 24 hours
      },
      // Removed defaultIntegration - prevents $default route from forwarding OPTIONS requests to Lambda
    });

    // Enable access logging on the default stage via escape hatch (APIG1)
    const defaultStage = this.httpApi.defaultStage?.node.defaultChild as cdk.CfnResource;
    if (defaultStage) {
      defaultStage.addPropertyOverride('AccessLogSettings', {
        DestinationArn: apiAccessLogGroup.logGroupArn,
        Format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          requestTime: '$context.requestTime',
          httpMethod: '$context.httpMethod',
          routeKey: '$context.routeKey',
          status: '$context.status',
          protocol: '$context.protocol',
          responseLength: '$context.responseLength',
          integrationError: '$context.integrationErrorMessage',
        }),
      });
    }

    // Forward all routes to Lambda function
    // Lambda Web Adapter handles Express routing internally
    // OPTIONS excluded as it is handled by API Gateway corsPreflight
    this.httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [
        apigatewayv2.HttpMethod.GET,
        apigatewayv2.HttpMethod.POST,
        apigatewayv2.HttpMethod.PUT,
        apigatewayv2.HttpMethod.DELETE,
        apigatewayv2.HttpMethod.PATCH,
        apigatewayv2.HttpMethod.HEAD,
      ],
      integration: lambdaIntegration,
    });

    // Additional route for root path
    this.httpApi.addRoutes({
      path: '/',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lambdaIntegration,
    });

    // Get API URL
    this.apiUrl = this.httpApi.url!;

    // Add permission for API Gateway to invoke Lambda function
    this.lambdaFunction.addPermission('ApiGatewayInvokePermission', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${this.httpApi.httpApiId}/*`,
    });

    // CloudWatch Alarms (optional)
    this.lambdaFunction.metricErrors({
      period: cdk.Duration.minutes(5),
    });

    this.lambdaFunction.metricDuration({
      period: cdk.Duration.minutes(5),
    });

    // Add tags
    cdk.Tags.of(this.lambdaFunction).add('Component', 'BackendApi');
    cdk.Tags.of(this.httpApi).add('Component', 'BackendApi');
    cdk.Tags.of(lambdaExecutionRole).add('Component', 'BackendApi');
  }

  /**
   * Set additional environment variables for Lambda function
   */
  public addEnvironmentVariable(key: string, value: string): void {
    this.lambdaFunction.addEnvironment(key, value);
  }

  /**
   * Grant additional IAM permissions to Lambda function
   */
  public grantPermissions(statement: iam.PolicyStatement): void {
    this.lambdaFunction.addToRolePolicy(statement);
  }

  /**
   * Add additional routes to API Gateway
   */
  public addRoute(
    path: string,
    methods: apigatewayv2.HttpMethod[],
    integration?: apigatewayv2Integrations.HttpLambdaIntegration
  ): void {
    this.httpApi.addRoutes({
      path,
      methods,
      integration:
        integration ||
        new apigatewayv2Integrations.HttpLambdaIntegration(
          `Integration-${path.replace(/[^a-zA-Z0-9]/g, '')}`,
          this.lambdaFunction
        ),
    });
  }
}
