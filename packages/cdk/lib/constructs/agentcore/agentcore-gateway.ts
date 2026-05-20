import { Construct } from 'constructs';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Aws, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as path from 'path';
import { CognitoAuth } from '../auth';

/**
 * Repo root. cdk is always invoked from `packages/cdk/`, so two levels up reaches
 * the monorepo root. Used to resolve Lambda `entry` paths consistently with the
 * other constructs in this package (see backend-api.ts, frontend.ts, etc.).
 */
const PROJECT_ROOT = path.resolve(process.cwd(), '../..');

export interface AgentCoreGatewayProps {
  /**
   * Gateway name
   * Valid characters: a-z, A-Z, 0-9, _ (underscore), - (hyphen)
   * Maximum 100 characters
   */
  readonly gatewayName: string;

  /**
   * Gateway description (optional)
   * Maximum 200 characters
   */
  readonly description?: string;

  /**
   * Authentication type (optional)
   * @default cognito
   */
  readonly authType?: 'cognito' | 'iam' | 'jwt';

  /**
   * Cognito authentication settings (required when authType is 'cognito')
   * Uses externally created CognitoAuth
   */
  readonly cognitoAuth?: CognitoAuth;

  /**
   * JWT settings (required when authType is 'jwt')
   */
  readonly jwtConfig?: {
    readonly discoveryUrl: string;
    readonly allowedAudience?: string[];
    readonly allowedClients?: string[];
  };

  /**
   * MCP protocol settings (optional)
   */
  readonly mcpConfig?: {
    readonly instructions?: string;
    readonly searchType?: agentcore.McpGatewaySearchType;
    readonly supportedVersions?: agentcore.MCPProtocolVersion[];
  };

  /**
   * Whether to enable the Gateway Request Interceptor (optional)
   * When enabled, a Lambda interceptor is created that injects user context
   * (_context with userId, identityId, and storagePath) into tools/call request bodies.
   * @default false
   */
  readonly enableInterceptor?: boolean;

  /**
   * Cognito Identity Pool ID. Required when enableInterceptor is true.
   * The interceptor Lambda resolves the identityId via GetId and injects
   * it into _context so Lambda tools can use it for per-user S3 path construction.
   *
   * In AgentCoreStack, this is set after CognitoIdentityPool is created (step 8)
   * via interceptorLambda.addEnvironment('IDENTITY_POOL_ID', ...).
   * Pass a placeholder here and override with addEnvironment after creation.
   */
  readonly identityPoolId?: string;

  /**
   * Cognito User Pool ID. Required when enableInterceptor is true.
   * Used together with identityPoolId to build the Logins key for GetId.
   */
  readonly userPoolId?: string;
}

/**
 * Amazon Bedrock AgentCore Gateway Construct
 *
 * Creates a Gateway that serves as an integration point between agents and external services.
 */
export class AgentCoreGateway extends Construct {
  /**
   * Created Gateway instance
   */
  public readonly gateway: agentcore.Gateway;

  /**
   * Gateway ARN
   */
  public readonly gatewayArn: string;

  /**
   * Gateway ID
   */
  public readonly gatewayId: string;

  /**
   * Gateway endpoint URL
   */
  public readonly gatewayEndpoint: string;

  /**
   * IAM role for Gateway
   */
  public readonly gatewayRole: iam.Role;

  /**
   * Interceptor Lambda function (if enabled)
   */
  public readonly interceptorLambda?: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: AgentCoreGatewayProps) {
    super(scope, id);

    // Protocol configuration (MCP)
    const protocolConfiguration = new agentcore.McpProtocolConfiguration({
      instructions: props.mcpConfig?.instructions || 'Use this Gateway to connect to MCP tools',
      searchType: props.mcpConfig?.searchType || agentcore.McpGatewaySearchType.SEMANTIC,
      supportedVersions: props.mcpConfig?.supportedVersions || [
        agentcore.MCPProtocolVersion.MCP_2025_03_26,
      ],
    });

    // Authentication configuration
    let authorizerConfiguration: agentcore.IGatewayAuthorizerConfig | undefined;

    switch (props.authType) {
      case 'iam':
        authorizerConfiguration = agentcore.GatewayAuthorizer.usingAwsIam();
        break;

      case 'jwt':
        if (!props.jwtConfig?.discoveryUrl) {
          throw new Error('discoveryUrl is required when using JWT authentication');
        }
        authorizerConfiguration = agentcore.GatewayAuthorizer.usingCustomJwt({
          discoveryUrl: props.jwtConfig.discoveryUrl,
          allowedAudience: props.jwtConfig.allowedAudience,
          allowedClients: props.jwtConfig.allowedClients,
        });
        break;

      case 'cognito':
      default: {
        // Use externally created Cognito authentication
        if (!props.cognitoAuth) {
          throw new Error('cognitoAuth is required when using Cognito authentication');
        }

        const jwtConfig = props.cognitoAuth.getJwtAuthorizerConfig();
        authorizerConfiguration = agentcore.GatewayAuthorizer.usingCustomJwt({
          discoveryUrl: jwtConfig.discoveryUrl,
          allowedClients: jwtConfig.allowedClients,
        });
        break;
      }
    }

    // Create Gateway (L2 Construct creates a secure role internally)
    this.gateway = new agentcore.Gateway(this, 'Gateway', {
      gatewayName: props.gatewayName,
      description: props.description,
      protocolConfiguration: protocolConfiguration,
      authorizerConfiguration: authorizerConfiguration,
    });

    // Add required permissions to the role created by L2 Construct
    // Cast IRole to Role to enable using addToPolicy method
    const gatewayRole = this.gateway.role as iam.Role;

    // GetGateway permission
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GetGateway',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:GetGateway'],
        resources: [`arn:aws:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:gateway/*`],
      })
    );

    // GetWorkloadAccessToken permission
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GetWorkloadAccessToken',
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:GetWorkloadAccessToken',
          'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:workload-identity-directory/*`,
        ],
      })
    );

    // GetResourceOauth2Token permission
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GetResourceOauth2Token',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:GetResourceOauth2Token'],
        resources: [
          `arn:aws:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:token-vault/*`,
          `arn:aws:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:workload-identity-directory/*`,
        ],
      })
    );

    // GetSecretValue permission
    // Scoped to the 'agentcore/' prefix matching the project's secret naming convention.
    // All project secrets follow the pattern: agentcore/{env}/{secret-name}
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GetSecretValue',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${Aws.REGION}:${Aws.ACCOUNT_ID}:secret:agentcore/*`],
      })
    );

    // Expose the role created by L2 Construct
    this.gatewayRole = gatewayRole;

    // Configure Gateway Interceptor (if enabled)
    if (props.enableInterceptor) {
      if (!props.identityPoolId || !props.userPoolId) {
        throw new Error(
          'identityPoolId and userPoolId are required when enableInterceptor is true'
        );
      }
      // Create Interceptor Lambda function
      const interceptorLogGroup = new logs.LogGroup(this, 'InterceptorLogGroup', {
        logGroupName: `/aws/lambda/${props.gatewayName}-gateway-interceptor`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      });

      this.interceptorLambda = new nodejs.NodejsFunction(this, 'InterceptorFunction', {
        functionName: `${props.gatewayName}-gateway-interceptor`,
        runtime: lambda.Runtime.NODEJS_22_X,
        // ARM64 (Graviton2) — pure Node.js + AWS SDK workload, no native bindings.
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(PROJECT_ROOT, 'packages/cdk/lambda/gateway-interceptor/index.ts'),
        handler: 'handler',
        timeout: Duration.seconds(10),
        memorySize: 128,
        logGroup: interceptorLogGroup,
        environment: {
          LOG_LEVEL: 'INFO',
          // identityPoolId is validated above; non-null assertion is safe here.
          IDENTITY_POOL_ID: props.identityPoolId!,
          COGNITO_USER_POOL_ID: props.userPoolId!,
        },
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'es2022',
          // Bundle @aws-sdk/client-cognito-identity (not available in Lambda runtime by default)
          externalModules: [],
        },
      });

      // Grant cognito-identity:GetId permission for identityId resolution
      this.interceptorLambda.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'CognitoGetId',
          effect: iam.Effect.ALLOW,
          actions: ['cognito-identity:GetId'],
          resources: [
            `arn:aws:cognito-identity:${Aws.REGION}:${Aws.ACCOUNT_ID}:identitypool/${props.identityPoolId!}`,
          ],
        })
      );

      this.gateway.addInterceptor(
        agentcore.LambdaInterceptor.forRequest(this.interceptorLambda, {
          passRequestHeaders: true,
        })
      );
    }

    this.gatewayArn = this.gateway.gatewayArn;
    this.gatewayId = this.gateway.gatewayId;
    this.gatewayEndpoint = this.gateway.gatewayUrl || '';
  }
}
