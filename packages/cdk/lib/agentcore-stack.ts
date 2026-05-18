import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import {
  AgentCoreGateway,
  AgentCoreMemory,
  AgentCoreRuntime,
  GitHubTokenBroker,
} from './constructs/agentcore';
import { AgentsTable, SessionsTable, TriggersTable, UserStorage } from './constructs/storage';
import { TriggerLambda, TriggerEventSources, SessionStreamHandler } from './constructs/triggers';
import { BackendApi, AppSyncEvents } from './constructs/api';
import { Frontend } from './constructs/frontend';
import { CognitoAuth, CognitoIdentityPool } from './constructs/auth';
import { OperationsDashboard } from './constructs/monitoring';
import { EnvironmentConfig } from '../config';

export interface AgentCoreStackProps extends cdk.StackProps {
  /**
   * Environment configuration (with all defaults applied)
   * Use getEnvironmentConfig() to get a fully resolved EnvironmentConfig
   */
  readonly envConfig: EnvironmentConfig;

  /**
   * Gateway name (optional)
   * Default: 'default-gateway'
   */
  readonly gatewayName?: string;

  /**
   * Gateway description (optional)
   */
  readonly gatewayDescription?: string;

  /**
   * Authentication type (optional)
   * Default: cognito
   */
  readonly authType?: 'cognito' | 'iam' | 'jwt';

  /**
   * Runtime authentication type (optional)
   * Default: jwt (uses same Cognito as Gateway)
   */
  readonly runtimeAuthType?: 'iam' | 'jwt';

  /**
   * JWT configuration (required when authType is 'jwt')
   */
  readonly jwtConfig?: {
    readonly discoveryUrl: string;
    readonly allowedAudience?: string[];
    readonly allowedClients?: string[];
  };

  /**
   * Memory name (optional)
   * Default: '{gatewayName}-memory'
   */
  readonly memoryName?: string;

  /**
   * Whether to use built-in memory strategies (optional)
   * Default: true (Summarization, Semantic, UserPreference)
   */
  readonly useBuiltInMemoryStrategies?: boolean;

  /**
   * Memory expiration period in days (optional)
   * Default: 90 days
   */
  readonly memoryExpirationDays?: number;

  /**
   * Tavily API Key Secret Name (Secrets Manager) (optional)
   * When set, runtime will retrieve API key from Secrets Manager
   */
  readonly tavilyApiKeySecretName?: string;

  /**
   * GitHub Token Secret Name (Secrets Manager) (optional)
   * When set, a dedicated GitHub Token Broker Lambda is created to fetch the token
   * from Secrets Manager. The Runtime is only granted `lambda:InvokeFunction` on the
   * broker — it cannot call Secrets Manager directly.
   */
  readonly githubTokenSecretName?: string;

  /**
   * WAF WebACL ARN from WafStack (us-east-1) to attach to CloudFront distribution (optional)
   * Created by WafStack and passed here via CDK crossRegionReferences.
   * When provided, attaches the WAF WebACL to the CloudFront distribution.
   */
  readonly webAclArn?: string;
}

/**
 * Amazon Bedrock AgentCore Stack
 *
 * CDK stack for deploying AgentCore Gateway and related resources
 */
export class AgentCoreStack extends cdk.Stack {
  /**
   * Created Cognito authentication system
   */
  public readonly cognitoAuth: CognitoAuth;

  /**
   * Created AgentCore Gateway
   */
  public readonly gateway: AgentCoreGateway;

  /**
   * Created AgentCore Runtime
   */
  public readonly agentRuntime: AgentCoreRuntime;

  /**
   * Created Backend API
   */
  public readonly backendApi: BackendApi;

  /**
   * Created Frontend
   */
  public readonly frontend: Frontend;

  /**
   * Created AgentCore Memory
   */
  public readonly memory: AgentCoreMemory;

  /**
   * Created User Storage
   */
  public readonly userStorage: UserStorage;

  /**
   * S3 access logs bucket (shared across stacks)
   */
  public readonly accessLogsBucket: s3.Bucket;

  /**
   * Created Agents Table
   */
  public readonly agentsTable: AgentsTable;

  /**
   * Created Sessions Table
   */
  public readonly sessionsTable: SessionsTable;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    if (!props.envConfig) {
      throw new Error('envConfig is required');
    }

    const envConfig = props.envConfig;

    // Configure resource prefix (from environment config, can be overridden by props.gatewayName)
    const resourcePrefix = props.gatewayName || envConfig.resourcePrefix;

    // 1. Create Cognito authentication system (shared by Gateway and Runtime)
    this.cognitoAuth = new CognitoAuth(this, 'CognitoAuth', {
      userPoolName: `${resourcePrefix}-user-pool`,
      domainPrefix: envConfig.cognitoDomainPrefix,
      appClientName: `${resourcePrefix}-client`,
      deletionProtection: envConfig.cognitoDeletionProtection,
      userPoolConfig: {
        selfSignUpEnabled: false, // Disable self sign-up by default
        autoVerify: {
          email: true, // Enable automatic email verification
        },
      },
      allowedSignUpEmailDomains: envConfig.allowedSignUpEmailDomains,
    });

    // 2. Create Cognito Identity Pool (needed by the Gateway Interceptor Lambda).
    // CDK tokens for userStorage.bucketName and sessionsTable.tableArn are resolved at
    // synth time, so it is safe to create the Identity Pool here even though the underlying
    // resources are defined later in the constructor.
    //
    // developerProviderName enables Developer Authenticated Identities so that Trigger
    // Lambda can issue a per-user OpenID Token via GetOpenIdTokenForDeveloperIdentity.
    const developerProviderName = `${resourcePrefix}.trigger`;
    const cognitoIdentityPool = new CognitoIdentityPool(this, 'CognitoIdentityPool', {
      cognitoAuth: this.cognitoAuth,
      resourcePrefix,
      userStorageBucketName: cdk.Lazy.string({
        produce: () => this.userStorage.bucketName,
      }),
      sessionsTableArn: cdk.Lazy.string({
        produce: () => this.sessionsTable.tableArn,
      }),
      // AgentCore Memory is constructed later in this stack (step 3 below).
      // Use cdk.Lazy.string to defer ARN resolution until synth, so the
      // Identity Pool policy references the final Memory ARN.
      agentCoreMemoryArn: cdk.Lazy.string({
        produce: () => this.memory.memoryArn,
      }),
      developerProviderName,
    });

    // 3. Create AgentCore Gateway
    this.gateway = new AgentCoreGateway(this, 'AgentCoreGateway', {
      gatewayName: resourcePrefix,
      description: props?.gatewayDescription || `AgentCore Gateway - ${resourcePrefix}`,
      authType: props?.authType || 'cognito',
      cognitoAuth: this.cognitoAuth,
      jwtConfig: props?.jwtConfig,
      enableInterceptor: true, // Enable JWT context injection for Lambda tools
      identityPoolId: cognitoIdentityPool.identityPoolId,
      userPoolId: this.cognitoAuth.userPoolId,
      mcpConfig: {
        instructions:
          'Use this Gateway to integrate AgentCore tools with external services. Utility tools (Echo/Ping, etc.) are available.',
      },
    });

    // Gateway attributes are exported for cross-stack reference by AgentCoreGatewayTargetStack.
    // Targets are managed in a separate stack to split the deployment unit,
    // allowing each target to be deployed independently without affecting core infrastructure.
    new cdk.CfnOutput(this, 'GatewayArn', {
      value: this.gateway.gatewayArn,
      description: 'AgentCore Gateway ARN',
      exportName: `${id}-GatewayArn`,
    });

    new cdk.CfnOutput(this, 'GatewayId', {
      value: this.gateway.gatewayId,
      description: 'AgentCore Gateway ID',
      exportName: `${id}-GatewayId`,
    });

    new cdk.CfnOutput(this, 'GatewayName', {
      value: resourcePrefix,
      description: 'AgentCore Gateway Name',
      exportName: `${id}-GatewayName`,
    });

    new cdk.CfnOutput(this, 'GatewayRoleArn', {
      value: this.gateway.gatewayRole.roleArn,
      description: 'AgentCore Gateway IAM Role ARN',
      exportName: `${id}-GatewayRoleArn`,
    });

    new cdk.CfnOutput(this, 'Region', {
      value: this.region,
      description: 'AWS Region',
      exportName: `${id}-Region`,
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.cognitoAuth.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.cognitoAuth.clientId,
      description: 'Cognito User Pool Client ID',
    });

    // 2.5. Create S3 Access Logs Bucket (shared by all S3 buckets and CloudFront)
    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      bucketName: `${resourcePrefix}-access-logs-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'DeleteOldLogs',
          expiration: cdk.Duration.days(90),
        },
      ],
      // objectOwnership is required for CloudFront logging
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
    });

    // Export log bucket ARN for cross-stack reference (Target stack)
    new cdk.CfnOutput(this, 'AccessLogsBucketArn', {
      value: this.accessLogsBucket.bucketArn,
      description: 'S3 Access Logs Bucket ARN',
      exportName: `${id}-AccessLogsBucketArn`,
    });

    new cdk.CfnOutput(this, 'AccessLogsBucketName', {
      value: this.accessLogsBucket.bucketName,
      description: 'S3 Access Logs Bucket Name',
      exportName: `${id}-AccessLogsBucketName`,
    });

    // 3. Create AgentCore Memory
    const memoryName = props?.memoryName || `${resourcePrefix.replace(/-/g, '_')}_memory`;
    const useBuiltInStrategies = props?.useBuiltInMemoryStrategies ?? true;
    const expirationDays = props?.memoryExpirationDays || envConfig.memoryExpirationDays;

    this.memory = new AgentCoreMemory(this, 'AgentCoreMemory', {
      memoryName: memoryName,
      description: `AgentCore Memory for ${resourcePrefix} - Conversation history persistence and context management`,
      expirationDuration: cdk.Duration.days(expirationDays),
      useBuiltInStrategies: useBuiltInStrategies,
      tags: {
        Project: 'AgentCore',
        Component: 'Memory',
        Gateway: resourcePrefix,
        Environment: envConfig.env,
      },
    });

    // 4. Create User Storage
    // identityPoolAuthRoleArnPattern is set after CognitoIdentityPool is created (step 8).
    // UserStorage accepts it as an optional prop; we pass it via the construct's
    // addToResourcePolicy override below after both are created.
    this.userStorage = new UserStorage(this, 'UserStorage', {
      bucketNamePrefix: resourcePrefix,
      retentionDays: 365,
      corsAllowedOrigins: envConfig.corsAllowedOrigins,
      removalPolicy: envConfig.s3RemovalPolicy,
      autoDeleteObjects: envConfig.s3AutoDeleteObjects,
      serverAccessLogsBucket: this.accessLogsBucket,
      // Identity Pool Authenticated Role ARN pattern for bucket policy Deny condition.
      // Pattern: arn:aws:iam::{account}:assumed-role/{prefix}-identity-pool-auth-{region}/*
      // This is computed eagerly using CDK tokens (resolved at deploy time).
      identityPoolAuthRoleArnPattern: `arn:aws:iam::${this.account}:assumed-role/${resourcePrefix}-identity-pool-auth-${this.region}/*`,
    });

    // 5. Create Agents Table
    this.agentsTable = new AgentsTable(this, 'AgentsTable', {
      tableNamePrefix: resourcePrefix,
      removalPolicy: envConfig.s3RemovalPolicy, // Use same removal policy as S3
      pointInTimeRecovery: true,
    });

    // 5.5. Create Sessions Table (with DynamoDB Streams for real-time updates)
    this.sessionsTable = new SessionsTable(this, 'SessionsTable', {
      tableNamePrefix: resourcePrefix,
      removalPolicy: envConfig.s3RemovalPolicy, // Use same removal policy as S3
      pointInTimeRecovery: true,
      enableStreams: true, // Enable DynamoDB Streams for real-time session updates
    });

    // 5.6. Create AppSync Events API for real-time session updates
    const appsyncEvents = new AppSyncEvents(this, 'AppSyncEvents', {
      apiName: `${resourcePrefix}-events`,
      userPool: this.cognitoAuth.userPool,
    });

    // 5.7. Create Session Stream Handler Lambda (DynamoDB Streams -> AppSync Events)
    const sessionStreamHandler = new SessionStreamHandler(this, 'SessionStreamHandler', {
      sessionsTable: this.sessionsTable.table,
      appsyncEvents: appsyncEvents,
    });

    // 5.8. Create Triggers Table
    const triggersTable = new TriggersTable(this, 'TriggersTable', {
      tableNamePrefix: resourcePrefix,
      removalPolicy: envConfig.s3RemovalPolicy,
      pointInTimeRecovery: true,
    });

    // 6. Create Backend API (Lambda Web Adapter) - Create before Runtime to pass URL
    // 6. Create Trigger Lambda (before Backend API to get ARN)
    const triggerLambda = new TriggerLambda(this, 'TriggerLambda', {
      resourcePrefix,
      triggersTable: triggersTable.table,
      agentsTable: this.agentsTable.table,
      agentApiUrl: '', // Will be set after Runtime is created
      cognitoUserPoolId: this.cognitoAuth.userPoolId,
      cognitoClientId: this.cognitoAuth.machineUserClientId,
      cognitoDomain: `${this.cognitoAuth.userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
      identityPoolId: cognitoIdentityPool.identityPoolId,
      developerProviderName,
    });

    // Create EventBridge Scheduler role
    const schedulerRole = triggerLambda.createSchedulerRole(this, resourcePrefix);

    // 6.5. Create Trigger Event Sources (EventBridge Rules) if configured
    let triggerEventSources: TriggerEventSources | undefined;
    if (envConfig.eventRules && envConfig.eventRules.length > 0) {
      triggerEventSources = new TriggerEventSources(this, 'TriggerEventSources', {
        resourcePrefix,
        eventRules: envConfig.eventRules,
        triggerLambda: triggerLambda.lambdaFunction,
      });
    }

    // 7. Create Backend API (Lambda Web Adapter) - Create before Runtime to pass URL
    this.backendApi = new BackendApi(this, 'BackendApi', {
      apiName: `${resourcePrefix}backendapi`,
      cognitoAuth: this.cognitoAuth,
      agentcoreGatewayEndpoint: `https://${this.gateway.gatewayId}.gateway.bedrock-agentcore.${this.region}.amazonaws.com/mcp`,
      agentcoreMemoryId: this.memory.memoryId,
      agentcoreSemanticStrategyId: this.memory.semanticStrategyId,
      corsAllowedOrigins: envConfig.corsAllowedOrigins,

      timeout: 30,
      memorySize: 1024,
      userStorageBucketName: this.userStorage.bucketName,
      agentsTableName: this.agentsTable.tableName,
      sessionsTableName: this.sessionsTable.tableName,
      logRetention: envConfig.logRetentionDays,
      bedrockModels: envConfig.bedrockModels!,
    });

    // Backend API user-scoped S3 access via STS AssumeRole with Session Policy
    const backendUserScopedS3Role = new cdk.aws_iam.Role(this, 'BackendUserScopedS3Role', {
      assumedBy: new cdk.aws_iam.ArnPrincipal(this.backendApi.lambdaFunction.role!.roleArn),
      description: 'Role assumed by Backend API with per-user session policies to scope S3 access',
      maxSessionDuration: cdk.Duration.hours(1),
    });

    backendUserScopedS3Role.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'S3UserStorageAccess',
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:ListBucket',
          's3:HeadObject',
        ],
        resources: [
          `arn:aws:s3:::${this.userStorage.bucketName}`,
          `arn:aws:s3:::${this.userStorage.bucketName}/*`,
        ],
      })
    );

    this.backendApi.lambdaFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'AssumeUserScopedS3Role',
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [backendUserScopedS3Role.roleArn],
      })
    );

    this.backendApi.addEnvironmentVariable('USER_SCOPED_ROLE_ARN', backendUserScopedS3Role.roleArn);

    // SSM Parameter Store prefix for MCP env values
    const ssmParameterPrefix = `/agentcore/${resourcePrefix}`;

    // Add SSM_PARAMETER_PREFIX environment variable to Backend API
    this.backendApi.addEnvironmentVariable('SSM_PARAMETER_PREFIX', ssmParameterPrefix);

    // Grant Backend API SSM read/write access for MCP env values
    this.backendApi.lambdaFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'SsmMcpEnvReadWrite',
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['ssm:PutParameter', 'ssm:GetParameter', 'ssm:DeleteParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${ssmParameterPrefix}/agents/*`,
        ],
      })
    );

    // Grant Agents Table read/write access to Backend API
    this.agentsTable.grantReadWrite(this.backendApi.lambdaFunction);

    // Grant Sessions Table read/write access to Backend API
    this.sessionsTable.grantReadWrite(this.backendApi.lambdaFunction);

    // Grant Triggers Table read/write access to Backend API
    triggersTable.grantReadWrite(this.backendApi.lambdaFunction);

    // Grant EventBridge Scheduler permissions to Backend API
    // Scoped to the 'default' schedule group only.
    this.backendApi.lambdaFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'SchedulerManageSchedules',
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
          'scheduler:GetSchedule',
          'scheduler:ListSchedules',
        ],
        resources: [`arn:aws:scheduler:${this.region}:${this.account}:schedule/default/*`],
      })
    );

    // Grant Backend API permission to pass the Scheduler role to EventBridge Scheduler.
    // Scoped to the specific SchedulerRole ARN to prevent privilege escalation.
    this.backendApi.lambdaFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'PassSchedulerRole',
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [schedulerRole.roleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'scheduler.amazonaws.com',
          },
        },
      })
    );

    // Add environment variables for trigger management to Backend API
    this.backendApi.lambdaFunction.addEnvironment('TRIGGERS_TABLE_NAME', triggersTable.tableName);
    this.backendApi.lambdaFunction.addEnvironment('TRIGGER_LAMBDA_ARN', triggerLambda.functionArn);
    this.backendApi.lambdaFunction.addEnvironment('SCHEDULER_ROLE_ARN', schedulerRole.roleArn);
    this.backendApi.lambdaFunction.addEnvironment('SCHEDULE_GROUP_NAME', 'default');

    // Add event sources config if event rules are configured
    if (triggerEventSources) {
      this.backendApi.lambdaFunction.addEnvironment(
        'EVENT_SOURCES_CONFIG',
        triggerEventSources.eventSourcesConfig
      );

      // Add CloudFormation Output for local development
      new cdk.CfnOutput(this, 'EventSourcesConfig', {
        value: triggerEventSources.eventSourcesConfig,
        description: 'Event sources configuration (JSON)',
        exportName: `${id}-EventSourcesConfig`,
      });
    }

    // Add GitHub Webhook Secret Name and permissions for webhook endpoint
    if (envConfig.githubWebhookSecretName) {
      this.backendApi.lambdaFunction.addEnvironment(
        'GITHUB_WEBHOOK_SECRET_NAME',
        envConfig.githubWebhookSecretName
      );

      // Grant Secrets Manager read access for webhook secret
      this.backendApi.lambdaFunction.addToRolePolicy(
        new cdk.aws_iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [
            `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${envConfig.githubWebhookSecretName}*`,
          ],
        })
      );

      // Grant EventBridge PutEvents for forwarding webhook events
      this.backendApi.lambdaFunction.addToRolePolicy(
        new cdk.aws_iam.PolicyStatement({
          actions: ['events:PutEvents'],
          resources: [`arn:aws:events:${this.region}:${this.account}:event-bus/default`],
        })
      );
    }

    // Pass Identity Pool configuration to Backend API Lambda so it can resolve
    // identityId from the Cognito ID Token forwarded by the frontend.
    this.backendApi.addEnvironmentVariable('IDENTITY_POOL_ID', cognitoIdentityPool.identityPoolId);
    this.backendApi.addEnvironmentVariable('COGNITO_USER_POOL_ID', this.cognitoAuth.userPoolId);

    // aws-jwt-verify requires an explicit client_id / aud allow-list to
    // reject tokens minted for any other App Client on the same user pool.
    // Passing both the frontend client and the machine-user client ensures
    // we accept browser-originated access tokens as well as Trigger Lambda
    // machine-user access tokens, but nothing else.
    this.backendApi.addEnvironmentVariable(
      'COGNITO_USER_POOL_CLIENT_ID',
      this.cognitoAuth.clientId
    );
    this.backendApi.addEnvironmentVariable(
      'COGNITO_MACHINE_USER_CLIENT_ID',
      this.cognitoAuth.machineUserClientId
    );

    // DEVELOPER_PROVIDER_NAME enables Backend to call GetOpenIdTokenForDeveloperIdentity
    // on every frontend login, linking the developer login { developerProviderName: userId }
    // to the user's Identity Pool identity A. Without this link, Trigger Lambda would
    // create a second Identity Pool identity on the first event fire (see
    // docs/adr/event-driven-identity-pool-credentials.md). The Agent container performs the
    // same link, but only for users who actually hit the Runtime — backend coverage
    // guarantees the link for users who only create event triggers via the web UI.
    this.backendApi.addEnvironmentVariable('DEVELOPER_PROVIDER_NAME', developerProviderName);

    // Grant Backend API the minimum IAM permission required to establish the link.
    // Scoped to this Identity Pool only. The call is idempotent and the target
    // IdentityId must match the UserPool idToken, so the blast radius of a stolen
    // Backend execution-role credential remains limited to tokens the attacker
    // already possesses.
    this.backendApi.lambdaFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'CognitoIdentityDeveloperAuthLink',
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['cognito-identity:GetOpenIdTokenForDeveloperIdentity'],
        resources: [
          `arn:aws:cognito-identity:${this.region}:${this.account}:identitypool/${cognitoIdentityPool.identityPoolId}`,
        ],
      })
    );

    // 8.5. Create GitHub Token Broker Lambda (before Runtime so we can pass
    // its ARN to the Runtime's environment). The broker is the SOLE caller
    // of `secretsmanager:GetSecretValue` on the GitHub PAT; the Runtime
    // execution role is restricted to `lambda:InvokeFunction` on this ARN.
    const githubTokenSecretName =
      props?.githubTokenSecretName || envConfig.githubTokenSecretName;
    const githubTokenBroker = githubTokenSecretName
      ? new GitHubTokenBroker(this, 'GitHubTokenBroker', {
          resourcePrefix,
          githubTokenSecretName,
          logRetention: envConfig.logRetentionDays
            ? cdk.aws_logs.RetentionDays.ONE_WEEK
            : undefined,
        })
      : undefined;

    // 9. Create AgentCore Runtime
    this.agentRuntime = new AgentCoreRuntime(this, 'AgentCoreRuntime', {
      runtimeName: resourcePrefix,
      description: `TypeScript-based Strands Agent Runtime - ${resourcePrefix}`,
      region: this.region,
      authType: props?.runtimeAuthType || 'jwt',
      cognitoAuth: this.cognitoAuth,
      gateway: this.gateway, // Gateway endpoint configuration for JWT propagation
      corsAllowedOrigins: envConfig.corsAllowedOrigins.join(','),
      memory: {
        memoryId: this.memory.memoryId,
        enabled: true,
        semanticStrategyId: this.memory.semanticStrategyId,
      },
      // Broker ARN (not the secret name) is the only GitHub-related value the
      // Runtime sees. startup.sh unsets this env var after boot.
      githubTokenBrokerLambdaArn: githubTokenBroker?.functionArn,
      userStorageBucketName: this.userStorage.bucketName, // Pass User Storage bucket name
      sessionsTableName: this.sessionsTable.tableName, // Pass Sessions Table name
      identityPoolId: cognitoIdentityPool.identityPoolId, // Identity Pool for user-scoped credentials
      cognitoUserPoolId: this.cognitoAuth.userPoolId, // User Pool ID for GetCredentialsForIdentity Logins key
      backendApiUrl: this.backendApi.apiUrl, // Pass Backend API URL for call_agent tool
      appsyncHttpEndpoint: appsyncEvents.httpEndpoint, // Pass AppSync Events HTTP endpoint for real-time messages
      bedrockModels: envConfig.bedrockModels!, // Pass allowed models for IAM policy scoping
    });

    // Pin the broker's resource-based policy Principal to the Runtime
    // execution role ARN so no other caller in this account can invoke it
    // even if they somehow obtain `lambda:InvokeFunction` on the ARN.
    // The identity-side statement is owned by AgentCoreRuntime
    // (see `InvokeGitHubTokenBroker` sid in agentcore-runtime.ts).
    if (githubTokenBroker) {
      const runtimeRole = this.agentRuntime.runtime.role as cdk.aws_iam.IRole;
      githubTokenBroker.allowInvocationBy(runtimeRole);
    }

    // AgentCore Memory access (both data-plane AND meta-plane) is handled
    // exclusively via Cognito Identity Pool credentials that the Runtime
    // exchanges from the incoming Cognito ID Token. The Runtime execution
    // role therefore has NO Memory permissions at all — per-user isolation
    // is enforced entirely by IAM condition keys
    // (bedrock-agentcore:actorId / bedrock-agentcore:namespace) on the
    // Authenticated Role.
    //
    // The Backend Lambda execution role is also intentionally NOT granted
    // Memory permissions — it forwards the user's ID token and constructs
    // its own user-scoped clients via GetCredentialsForIdentity.
    //
    // Sessions Table and S3 access follow the same pattern (per-user IAM
    // policy variables on the Authenticated Role).

    // Add SSM_PARAMETER_PREFIX environment variable to Trigger Lambda
    triggerLambda.lambdaFunction.addEnvironment('SSM_PARAMETER_PREFIX', ssmParameterPrefix);

    // Grant Trigger Lambda SSM read-only access for MCP env values
    triggerLambda.lambdaFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'SsmMcpEnvRead',
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${ssmParameterPrefix}/agents/*`,
        ],
      })
    );

    // Update Trigger Lambda with Agent API URL (now available from Runtime)
    triggerLambda.lambdaFunction.addEnvironment(
      'AGENT_API_URL',
      `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/${this.agentRuntime.runtimeArn}/invocations?qualifier=DEFAULT`
    );

    // 10. Create Frontend
    this.frontend = new Frontend(this, 'Frontend', {
      resourcePrefix: resourcePrefix,
      userPoolId: this.cognitoAuth.userPoolId,
      userPoolClientId: this.cognitoAuth.clientId,
      runtimeEndpoint: `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/${this.agentRuntime.runtimeArn}/invocations?qualifier=DEFAULT`,
      awsRegion: this.region,
      backendApiUrl: this.backendApi.apiUrl,
      customDomain: envConfig.customDomain,
      appsyncEventsEndpoint: appsyncEvents.realtimeEndpoint, // AppSync Events WebSocket endpoint for real-time updates
      bedrockModels: envConfig.bedrockModels,
      serverAccessLogsBucket: this.accessLogsBucket,
      geoRestriction: envConfig.cloudFrontGeoRestriction, // Geo restriction (all envs)
      webAclArn: props.webAclArn, // WAF WebACL ARN from WafStack (us-east-1)
      identityPoolId: cognitoIdentityPool.identityPoolId, // Identity Pool ID for per-user credentials
      selfSignUpEnabled: false,
    });

    // 10. Additional CloudFormation outputs (authentication related)
    new cdk.CfnOutput(this, 'GatewayMcpEndpoint', {
      value: `https://${this.gateway.gatewayId}.gateway.bedrock-agentcore.${this.region}.amazonaws.com/mcp`,
      description: 'AgentCore Gateway MCP Endpoint',
      exportName: `${id}-GatewayMcpEndpoint`,
    });

    new cdk.CfnOutput(this, 'RuntimeInvocationEndpoint', {
      value: `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/${this.agentRuntime.runtimeArn}/invocations?qualifier=DEFAULT`,
      description: 'AgentCore Runtime Invocation Endpoint (JWT Bearer Token required)',
      exportName: `${id}-RuntimeInvocationEndpoint`,
    });

    new cdk.CfnOutput(this, 'WebAppFrontendUrl', {
      value: this.frontend.websiteUrl,
      description: 'Frontend Website URL',
      exportName: `${id}-WebAppFrontendUrl`,
    });

    new cdk.CfnOutput(this, 'AuthenticationSummary', {
      value: `Gateway: JWT authentication, Runtime: JWT authentication (Shared Cognito User Pool: ${this.cognitoAuth.userPoolId})`,
      description: 'Authentication configuration summary',
    });

    new cdk.CfnOutput(this, 'CorsConfiguration', {
      value: `CORS configuration: Allowed origins="*" (development), Frontend URL="${this.frontend.websiteUrl}"`,
      description: 'CORS configuration summary',
    });

    // Helper outputs for creating test users
    new cdk.CfnOutput(this, 'CreateTestUserCommand', {
      value: `aws cognito-idp admin-create-user --user-pool-id ${this.cognitoAuth.userPoolId} --username testuser --message-action SUPPRESS --region ${this.region}`,
      description: 'Example command to create test user',
    });

    new cdk.CfnOutput(this, 'SetUserPasswordCommand', {
      value: `aws cognito-idp admin-set-user-password --user-pool-id ${this.cognitoAuth.userPoolId} --username testuser --password YourPassword123! --permanent --region ${this.region}`,
      description: 'Example command to set user password',
    });

    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: this.agentRuntime.runtimeArn,
      description: 'AgentCore Runtime ARN',
      exportName: `${id}-AgentRuntimeArn`,
    });

    new cdk.CfnOutput(this, 'AgentRuntimeId', {
      value: this.agentRuntime.runtimeId,
      description: 'AgentCore Runtime ID',
      exportName: `${id}-AgentRuntimeId`,
    });

    // Memory-related outputs
    new cdk.CfnOutput(this, 'MemoryId', {
      value: this.memory.memoryId,
      description: 'AgentCore Memory ID',
      exportName: `${id}-MemoryId`,
    });

    new cdk.CfnOutput(this, 'MemoryArn', {
      value: this.memory.memoryArn,
      description: 'AgentCore Memory ARN',
      exportName: `${id}-MemoryArn`,
    });

    new cdk.CfnOutput(this, 'MemoryName', {
      value: this.memory.memoryName,
      description: 'AgentCore Memory Name',
      exportName: `${id}-MemoryName`,
    });

    // Semantic memory strategyId resolved at deploy time by
    // AgentCoreMemory.semanticStrategyId (AwsCustomResource + GetMemory).
    // Exported so that setup-env.ts can inject it into the local .env files
    // for backend / agent development.
    new cdk.CfnOutput(this, 'MemorySemanticStrategyId', {
      value: this.memory.semanticStrategyId ?? '',
      description: 'AgentCore Memory semantic strategy id (deploy-time resolved)',
      exportName: `${id}-MemorySemanticStrategyId`,
    });

    new cdk.CfnOutput(this, 'MemoryConfiguration', {
      value: `Memory: ${this.memory.memoryName} (${this.memory.memoryId}) - Conversation history persistence enabled`,
      description: 'AgentCore Memory configuration summary',
    });

    // Backend API-related outputs
    new cdk.CfnOutput(this, 'BackendApiUrl', {
      value: this.backendApi.apiUrl,
      description: 'Backend API Endpoint URL',
      exportName: `${id}-BackendApiUrl`,
    });

    new cdk.CfnOutput(this, 'BackendApiFunctionName', {
      value: this.backendApi.lambdaFunction.functionName,
      description: 'Backend API Lambda Function Name',
      exportName: `${id}-BackendApiFunctionName`,
    });

    new cdk.CfnOutput(this, 'BackendApiFunctionArn', {
      value: this.backendApi.lambdaFunction.functionArn,
      description: 'Backend API Lambda Function ARN',
      exportName: `${id}-BackendApiFunctionArn`,
    });

    new cdk.CfnOutput(this, 'BackendApiConfiguration', {
      value: `Backend API: ${this.backendApi.apiUrl} (Lambda Web Adapter + Express.js)`,
      description: 'Backend API configuration summary',
    });

    // User Storage-related outputs
    new cdk.CfnOutput(this, 'UserStorageBucketName', {
      value: this.userStorage.bucketName,
      description: 'User Storage S3 Bucket Name',
      exportName: `${id}-UserStorageBucketName`,
    });

    new cdk.CfnOutput(this, 'UserStorageBucketArn', {
      value: this.userStorage.bucketArn,
      description: 'User Storage S3 Bucket ARN',
      exportName: `${id}-UserStorageBucketArn`,
    });

    new cdk.CfnOutput(this, 'UserStorageConfiguration', {
      value: `User Storage: ${this.userStorage.bucketName} - User file storage`,
      description: 'User Storage configuration summary',
    });

    // Agents Table-related outputs
    new cdk.CfnOutput(this, 'AgentsTableName', {
      value: this.agentsTable.tableName,
      description: 'Agents DynamoDB Table Name',
      exportName: `${id}-AgentsTableName`,
    });

    new cdk.CfnOutput(this, 'AgentsTableArn', {
      value: this.agentsTable.tableArn,
      description: 'Agents DynamoDB Table ARN',
      exportName: `${id}-AgentsTableArn`,
    });

    new cdk.CfnOutput(this, 'AgentsTableConfiguration', {
      value: `Agents Table: ${this.agentsTable.tableName} - User agent storage`,
      description: 'Agents Table configuration summary',
    });

    // Sessions Table-related outputs
    new cdk.CfnOutput(this, 'SessionsTableName', {
      value: this.sessionsTable.tableName,
      description: 'Sessions DynamoDB Table Name',
      exportName: `${id}-SessionsTableName`,
    });

    new cdk.CfnOutput(this, 'SessionsTableArn', {
      value: this.sessionsTable.tableArn,
      description: 'Sessions DynamoDB Table ARN',
      exportName: `${id}-SessionsTableArn`,
    });

    new cdk.CfnOutput(this, 'SessionsTableConfiguration', {
      value: `Sessions Table: ${this.sessionsTable.tableName} - User session storage`,
      description: 'Sessions Table configuration summary',
    });

    // AppSync Events-related outputs (for real-time session updates)
    new cdk.CfnOutput(this, 'AppSyncEventsRealtimeEndpoint', {
      value: appsyncEvents.realtimeEndpoint,
      description: 'AppSync Events WebSocket endpoint for real-time subscriptions',
      exportName: `${id}-AppSyncEventsRealtimeEndpoint`,
    });

    new cdk.CfnOutput(this, 'AppSyncEventsHttpEndpoint', {
      value: appsyncEvents.httpEndpoint,
      description: 'AppSync Events HTTP endpoint for publishing',
      exportName: `${id}-AppSyncEventsHttpEndpoint`,
    });

    new cdk.CfnOutput(this, 'AppSyncEventsConfiguration', {
      value: `AppSync Events: ${appsyncEvents.apiId} - Real-time session updates enabled`,
      description: 'AppSync Events configuration summary',
    });

    // Note: Trigger-related outputs are already defined in construct files:
    // - TriggersTableName: triggers-table.ts
    // - TriggerLambdaArn: trigger-lambda.ts
    // - SchedulerRoleArn: trigger-lambda.ts (createSchedulerRole method)

    new cdk.CfnOutput(this, 'TriggerConfiguration', {
      value: `Triggers: ${triggersTable.tableName} - Scheduled agent execution enabled`,
      description: 'Event-driven Triggers configuration summary',
    });

    // Trigger-related outputs (for setup-env.ts)
    new cdk.CfnOutput(this, 'TriggersTableName', {
      value: triggersTable.tableName,
      description: 'Triggers DynamoDB Table Name',
      exportName: `${id}-TriggersTableName`,
    });

    new cdk.CfnOutput(this, 'TriggerLambdaArn', {
      value: triggerLambda.functionArn,
      description: 'Trigger Lambda Function ARN',
      exportName: `${id}-TriggerLambdaArn`,
    });

    new cdk.CfnOutput(this, 'SchedulerRoleArn', {
      value: schedulerRole.roleArn,
      description: 'EventBridge Scheduler IAM Role ARN',
      exportName: `${id}-SchedulerRoleArn`,
    });

    // Developer Authenticated Identities outputs (for setup-env.ts)
    //
    // CognitoIdentityPool construct also emits a CfnOutput for IdentityPoolId, but CDK prefixes
    // construct-level outputs with the construct path (e.g. CognitoIdentityPoolIdentityPoolIdXXX),
    // so setup-env.ts cannot find it as 'IdentityPoolId'. We add a stack-level output here
    // (no exportName to avoid collision with the construct's exportName).
    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: cognitoIdentityPool.identityPoolId,
      description: 'Cognito Identity Pool ID (used for per-user credential exchange)',
    });

    // Add tags
    cdk.Tags.of(this).add('Project', 'AgentCore');
    cdk.Tags.of(this).add('Component', 'Gateway');
    cdk.Tags.of(this).add('Memory', 'Enabled');
    cdk.Tags.of(this).add('BackendApi', 'Enabled');
    cdk.Tags.of(this).add('UserStorage', 'Enabled');
    cdk.Tags.of(this).add('AgentsTable', 'Enabled');
    cdk.Tags.of(this).add('SessionsTable', 'Enabled');
    cdk.Tags.of(this).add('TriggersTable', 'Enabled');
    cdk.Tags.of(this).add('TriggerLambda', 'Enabled');

    // ── Operations Dashboard ──
    new OperationsDashboard(this, 'OperationsDashboard', {
      resourcePrefix,
      stackName: id,
      backendApiFunction: this.backendApi.lambdaFunction,
      sessionStreamHandlerFunction: sessionStreamHandler.handler,
      triggerExecutorFunction: triggerLambda.lambdaFunction,
      gatewayInterceptorFunction: this.gateway.interceptorLambda,
      httpApi: this.backendApi.httpApi,
      agentsTable: this.agentsTable.table,
      sessionsTable: this.sessionsTable.table,
      triggersTable: triggersTable.table,
      cloudFrontDistribution: this.frontend.cloudFrontDistribution,
      userStorageBucket: this.userStorage.bucket,
    });

    // ── cdk-nag Suppressions ──

    // Stack-level suppressions (applies to all resources in this stack)
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSLambdaBasicExecutionRole is the standard managed policy for Lambda functions to write CloudWatch Logs.',
      },
      {
        id: 'AwsSolutions-L1',
        reason:
          'Lambda runtime versions are managed by CDK internal Custom Resources and deploy-time-build constructs which are not directly controllable.',
      },
      {
        id: 'AwsSolutions-CB4',
        reason:
          'CodeBuild projects created by deploy-time-build (@cdklabs/deploy-time-build) do not expose KMS encryption configuration.',
      },
      {
        id: 'AwsSolutions-APIG4',
        reason:
          'HTTP API v2 does not use API Gateway authorizers. JWT authentication is implemented at the Express.js application layer.',
      },
      {
        id: 'AwsSolutions-APIG1',
        reason:
          'Access logging is configured via CfnStage escape hatch (AccessLogSettings property override). cdk-nag may not detect escape hatch modifications.',
      },
      {
        id: 'AwsSolutions-COG2',
        reason:
          'MFA is not required for this PoV/development stage. Will be enabled for production.',
      },
      {
        id: 'AwsSolutions-CFR4',
        reason:
          'CloudFront default certificate (*.cloudfront.net) does not support setting minimumProtocolVersion above TLSv1. Custom domain with TLSv1.2 certificate will be configured for production.',
      },
    ]);

    // ── Per-resource IAM5 suppressions ──

    // CDK internal Custom Resource provider framework and deploy-time-build (CodeBuild)
    // generate wildcard policies that cannot be controlled from application code.
    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'CDK internal Custom Resource provider framework and deploy-time-build (CodeBuild) generate wildcard policies (logs:*, lambda:*, ecr:*, s3:*, codebuild:*) that are not directly controllable from application code.',
          appliesTo: [
            'Resource::*',
            'Action::logs:*',
            'Action::lambda:*',
            'Action::ecr:*',
            'Action::s3:*',
            'Action::codebuild:*',
            'Action::s3:Abort*',
            'Action::s3:DeleteObject*',
            'Action::s3:GetBucket*',
            'Action::s3:GetObject*',
            'Action::s3:List*',
          ],
        },
      ],
      true
    );

    // EventBridge Scheduler role: Lambda ARN:* suffix for version/alias invocation.
    // CDK generates this pattern automatically when creating a Scheduler target.
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/SchedulerRole/DefaultPolicy/Resource`],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Lambda ARN:* suffix is required for EventBridge Scheduler to invoke Lambda function versions and aliases. This pattern is generated by CDK when creating a Scheduler target.',
        },
      ]
    );

    // AgentCore Memory execution role: CloudWatch Logs wildcard for memory log group
    // The memory log group name ends with * because it is suffixed by AgentCore at runtime.
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/AgentCoreMemory/ExecutionRole/DefaultPolicy/Resource`],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'AgentCore Memory log group ARN uses a wildcard suffix because the exact log group name is appended by the service at runtime and is not fully known at deploy time.',
        },
      ]
    );

    // deploy-time-build (CodeBuild) roles: CDK-generated token-based log group ARNs,
    // report-group ARNs, and CDK bootstrap bucket access (cdk-hnb659fds-assets-*).
    // These are generated internally by @cdklabs/deploy-time-build and cannot be suppressed
    // via Resource::* alone because cdk-nag inspects the resolved token patterns individually.
    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'deploy-time-build (CodeBuild) and Frontend build roles generate token-based log group / report-group / CDK bootstrap bucket resource ARNs that cannot be controlled from application code.',
          appliesTo: [
            // CDK Pseudo-parameter based ARNs (e.g. <AWS::Region>, <AWS::AccountId> tokens)
            `Resource::arn:aws:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/codebuild/*`,
            `Resource::arn:aws:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/codebuild/*:*`,
            // Resolved ARNs with CDK token hash in log group / report-group names
            { regex: '/^Resource::arn:aws:logs:.+:log-group:\\/aws\\/codebuild\\/.+:\\*$/' },
            { regex: '/^Resource::arn:aws:codebuild:.+:report-group\\/.+-\\*$/' },
            { regex: '/^Resource::arn:aws:s3:::cdk-[a-z0-9]+-assets-.+\\*$/' },
            { regex: '/^Resource::<.+\\.Arn>\\/\\*$/' },
          ],
        },
      ],
      true
    );

    // Backend API execution role: all addToRolePolicy and grantReadWrite calls land here
    // because BackendApiFunction uses an explicit role (BackendApiExecutionRole).
    // Wildcards: DynamoDB GSI index/*, SSM parameters/agents/*,
    // Scheduler schedule/default/*, Secrets Manager random suffix.
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/BackendApi/BackendApiExecutionRole/DefaultPolicy/Resource`],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'DynamoDB index/* is required because CDK grantReadWrite automatically adds GSI index/* to allow Query operations on all global secondary indexes of the table. SSM parameter/agents/* is required to scope per-agent parameters. Scheduler schedule/default/* scopes to the default group only. Secrets Manager suffix wildcard is unavoidable due to auto-generated 6-char suffix appended by AWS.',
        },
      ]
    );

    // AgentCore Runtime role: CloudWatch Logs (log-group:*, log-stream:*),
    // X-Ray (Resource::*), CloudWatch metrics (Resource::*),
    // AppSync channelNamespace (apis/*/channelNamespace/*),
    // Bedrock inference-profile/*, AgentCore Browser (browser/*).
    // Secrets Manager wildcard is NOT present here anymore — the Runtime role
    // no longer has `secretsmanager:GetSecretValue`; that permission lives
    // exclusively on the GitHubTokenBroker Lambda's execution role.
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/AgentCoreRuntime/Runtime/ExecutionRole/DefaultPolicy/Resource`],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'CloudWatch Logs log-group:* is required by the DescribeLogGroups API. X-Ray and CloudWatch PutMetricData require Resource:* by service design. AppSync apis/*/channelNamespace/* is required because AppSync API IDs and namespace names are dynamic. Bedrock inference-profile/* supports cross-region inference profiles. AgentCore Browser browser/* is required because browser session IDs are dynamic.',
        },
      ]
    );

    // GitHub Token Broker Lambda execution role: the Secrets Manager suffix
    // wildcard is unavoidable (AWS appends a 6-char random suffix). This is
    // the ONLY place in the stack that holds `secretsmanager:GetSecretValue`
    // on the GitHub PAT.
    if (githubTokenBroker) {
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        [`/${id}/GitHubTokenBroker/Function/ServiceRole/DefaultPolicy/Resource`],
        [
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'Secrets Manager resource ARN uses the 6-char random-suffix wildcard (`${name}-*`) that AWS appends automatically. Scoped to exactly one secret name.',
          },
        ]
      );
    }

    // Cognito Identity Pool Authenticated Role:
    // 1. S3 resource ARN contains IAM policy variable ${cognito-idp.../sub} which CDK resolves
    //    as a wildcard-like token. The effective resource is narrowed to users/{sub}/* by IAM
    //    at request evaluation time — it is not a true wildcard.
    // 2. DynamoDB Sessions table index/* is required for Query on GSIs.
    //    Per-user isolation is enforced by the dynamodb:LeadingKeys condition.
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/CognitoIdentityPool/AuthenticatedRole/DefaultPolicy/Resource`],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'S3 resource ARN uses the IAM policy variable ${cognito-idp.REGION.amazonaws.com/POOL_ID:sub} ' +
            'which CDK treats as a wildcard token but is resolved at request time to the authenticated ' +
            "user's Cognito sub UUID. DynamoDB index/* is required for GSI Query; per-user isolation " +
            'is enforced by the ForAllValues:StringEquals dynamodb:LeadingKeys condition.',
        },
      ]
    );

    // TriggerLambda role: SSM parameters/agents/*,
    // DynamoDB GSI index/* (CDK grantReadWriteData), CloudWatch Logs log-stream:*
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/TriggerLambda/Function/ServiceRole/DefaultPolicy/Resource`],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'SSM parameter/agents/* is required to scope per-agent parameters. DynamoDB index/* is generated by CDK grantReadWriteData for GSI access. CloudWatch Logs log-stream:* is standard for Lambda execution roles.',
        },
      ]
    );

    // TriggerLambda GetClientSecret custom resource: Cognito describeUserPoolClient
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/TriggerLambda/GetClientSecret/CustomResourcePolicy/Resource`],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Custom Resource policy for retrieving Cognito client secret is scoped to the specific user pool ARN. The Resource::* pattern here is the CDK Custom Resource framework default for the provider Lambda role.',
        },
      ]
    );

    // SessionStreamHandler role: AppSync apis/*/channelNamespace/* (grantPublish),
    // DynamoDB Streams (CDK grantStreamRead generates this)
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/SessionStreamHandler/Handler/ServiceRole/DefaultPolicy/Resource`],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'AppSync apis/*/channelNamespace/* is required because AppSync API ID and namespace names are dynamic (not known at synth time). DynamoDB stream/* is generated by CDK grantStreamRead.',
        },
      ]
    );

    // Gateway Role: workload-identity-directory/*, token-vault/*,
    // gateway/* (all Gateway IDs in account), Secrets Manager agentcore/*
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/AgentCoreGateway/Gateway/ServiceRole/DefaultPolicy/Resource`],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'AgentCore Gateway role requires workload-identity-directory/* and token-vault/* because workload identity and token vault IDs are dynamically assigned by the service. gateway/* is required as Gateway IDs are generated at runtime. Secrets Manager agentcore/* is scoped to the project prefix.',
        },
      ]
    );

    // Backend UserScopedS3Role: S3 bucket objects (bucketName/*)
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/BackendUserScopedS3Role/DefaultPolicy/Resource`],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'S3 bucket/* is required to allow object-level operations (GetObject, PutObject, DeleteObject) on user storage. Access is further restricted to per-user prefixes via STS session policy at AssumeRole time.',
        },
      ]
    );

    // Suppress S1 for access logs bucket itself (self-referencing loop prevention)
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/AccessLogsBucket/Resource`],
      [
        {
          id: 'AwsSolutions-S1',
          reason:
            'Access logs bucket cannot log to itself to avoid infinite loop. This is the centralized log destination.',
        },
      ]
    );

    // deploy-time-build NodejsBuild (FrontendBuild) creates an internal S3 cache
    // bucket for the npm cache when `cache: CacheType.S3` is enabled. The bucket
    // is created internally by @cdklabs/deploy-time-build and its properties
    // (including serverAccessLogsBucket) are not configurable from application
    // code. The cache stores npm tarball data only — no user data or secrets —
    // and is already encrypted with S3-managed keys by the construct.
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/Frontend/FrontendBuild/CacheBucket/Resource`],
      [
        {
          id: 'AwsSolutions-S1',
          reason:
            'The npm cache bucket is created internally by @cdklabs/deploy-time-build (NodejsBuild with CacheType.S3) and does not expose serverAccessLogsBucket configuration. The bucket holds only npm tarball cache (no user data or secrets) and is managed by the construct.',
        },
      ]
    );
  }
}
