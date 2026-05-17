import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

export interface TriggerLambdaProps {
  /**
   * Resource name prefix
   */
  readonly resourcePrefix: string;

  /**
   * Triggers DynamoDB table
   */
  readonly triggersTable: dynamodb.ITable;

  /**
   * Agents DynamoDB table
   */
  readonly agentsTable: dynamodb.ITable;

  /**
   * Agent API URL for invocations
   */
  readonly agentApiUrl: string;

  /**
   * Cognito User Pool ID for Machine User authentication
   */
  readonly cognitoUserPoolId: string;

  /**
   * Cognito Client ID for Machine User
   */
  readonly cognitoClientId: string;

  /**
   * Cognito Domain for OAuth2 token endpoint
   */
  readonly cognitoDomain: string;

  /**
   * Cognito Identity Pool ID.
   * Required for Developer Authenticated Identities (GetOpenIdTokenForDeveloperIdentity).
   * When provided, the Trigger Lambda obtains a per-user OpenID Token so the
   * AgentCore Runtime can exchange it for Identity Pool credentials scoped to
   * the target user's S3 prefix and DynamoDB partition key.
   */
  readonly identityPoolId: string;

  /**
   * Developer provider name registered on the Identity Pool.
   * Must match the developerProviderName set in CognitoIdentityPool construct.
   * Convention: "{resourcePrefix}.trigger"
   */
  readonly developerProviderName: string;

  /**
   * Lambda runtime (optional)
   * @default Runtime.NODEJS_22_X
   */
  readonly runtime?: lambda.Runtime;

  /**
   * Lambda timeout (optional)
   * @default 5 minutes
   */
  readonly timeout?: cdk.Duration;

  /**
   * Lambda memory size (optional)
   * @default 512MB
   */
  readonly memorySize?: number;
}

/**
 * Trigger Lambda Construct
 *
 * Lambda function that is invoked by EventBridge Scheduler to execute agent invocations.
 *
 * Responsibilities:
 * - Receive EventBridge Scheduler events
 * - Obtain Machine User authentication token from Cognito
 * - Invoke Agent API with the trigger configuration
 * - Record execution history in DynamoDB
 */
export class TriggerLambda extends Construct {
  /**
   * The Lambda function
   */
  public readonly lambdaFunction: nodejs.NodejsFunction;

  /**
   * The Lambda function ARN
   */
  public readonly functionArn: string;

  /**
   * The Lambda function name
   */
  public readonly functionName: string;

  constructor(scope: Construct, id: string, props: TriggerLambdaProps) {
    super(scope, id);

    // Get Cognito Client Secret using AwsCustomResource
    const getClientSecret = new cr.AwsCustomResource(this, 'GetClientSecret', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'describeUserPoolClient',
        parameters: {
          UserPoolId: props.cognitoUserPoolId,
          ClientId: props.cognitoClientId,
        },
        physicalResourceId: cr.PhysicalResourceId.of('TriggerMachineClientSecret'),
      },
      onUpdate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'describeUserPoolClient',
        parameters: {
          UserPoolId: props.cognitoUserPoolId,
          ClientId: props.cognitoClientId,
        },
        physicalResourceId: cr.PhysicalResourceId.of('TriggerMachineClientSecret'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cognito-idp:DescribeUserPoolClient'],
          resources: [
            `arn:aws:cognito-idp:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:userpool/${props.cognitoUserPoolId}`,
          ],
        }),
      ]),
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Explicit log group so stack deletion cleans it up and redeploys don't
    // collide with a previously auto-created group of the same name.
    const logGroup = new logs.LogGroup(this, 'FunctionLogGroup', {
      logGroupName: `/aws/lambda/${props.resourcePrefix}-trigger-executor`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create Lambda function
    this.lambdaFunction = new nodejs.NodejsFunction(this, 'Function', {
      functionName: `${props.resourcePrefix}-trigger-executor`,
      runtime: props.runtime || lambda.Runtime.NODEJS_22_X,
      // ARM64 (Graviton2) — pure Node.js + AWS SDK workload with no native
      // bindings, so we take the ~20% cost reduction and comparable perf.
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../../../trigger/src/index.ts'),
      handler: 'handler',
      timeout: props.timeout || cdk.Duration.minutes(5),
      memorySize: props.memorySize || 512,
      description: 'Event-driven trigger executor for AgentCore',
      logGroup,
      environment: {
        NODE_ENV: 'production',
        TRIGGERS_TABLE_NAME: props.triggersTable.tableName,
        AGENTS_TABLE_NAME: props.agentsTable.tableName,
        AGENT_API_URL: props.agentApiUrl,
        COGNITO_DOMAIN: props.cognitoDomain,
        COGNITO_CLIENT_ID: props.cognitoClientId,
        COGNITO_CLIENT_SECRET: getClientSecret.getResponseField('UserPoolClient.ClientSecret'),
        COGNITO_SCOPE: 'agent/invoke agent/tools',
        // Developer Authenticated Identities for per-user OpenID Token issuance
        IDENTITY_POOL_ID: props.identityPoolId,
        DEVELOPER_PROVIDER_NAME: props.developerProviderName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
        // No `externalModules` entry: Node 22 Lambda runtime does not ship
        // `aws-sdk` v2 anymore, and our code only uses AWS SDK v3
        // (`@aws-sdk/*`), which esbuild bundles alongside the handler.
      },
    });

    // Lambda depends on the custom resource that retrieves the secret
    this.lambdaFunction.node.addDependency(getClientSecret);

    this.functionArn = this.lambdaFunction.functionArn;
    this.functionName = this.lambdaFunction.functionName;

    // Grant DynamoDB read/write permissions
    props.triggersTable.grantReadWriteData(this.lambdaFunction);

    // Grant DynamoDB read permissions for Agents table
    props.agentsTable.grantReadData(this.lambdaFunction);

    // Grant Cognito access for Machine User authentication
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:InitiateAuth',
          'cognito-idp:GetUser',
          'cognito-idp:DescribeUserPoolClient',
        ],
        resources: [
          `arn:aws:cognito-idp:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:userpool/${props.cognitoUserPoolId}`,
        ],
      })
    );

    // Grant Cognito Identity Pool access for Developer Authenticated Identities.
    // GetOpenIdTokenForDeveloperIdentity issues a short-lived OpenID Token for a specific
    // user (identified by developerProviderName + userId), which the AgentCore Runtime
    // exchanges for per-user Identity Pool credentials via GetCredentialsForIdentity.
    // Scoped to the specific Identity Pool to minimize blast radius.
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CognitoIdentityDeveloperAuth',
        actions: ['cognito-identity:GetOpenIdTokenForDeveloperIdentity'],
        resources: [
          `arn:aws:cognito-identity:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:identitypool/${props.identityPoolId}`,
        ],
      })
    );

    // Add CloudWatch Logs permissions (automatically granted by CDK, but explicit for clarity)
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/lambda/${props.resourcePrefix}-trigger-executor:*`,
        ],
      })
    );

    // Add tags
    cdk.Tags.of(this.lambdaFunction).add('Component', 'TriggerExecution');
    cdk.Tags.of(this.lambdaFunction).add('Purpose', 'EventDrivenAgentInvocation');

    // Note: CfnOutput is defined in agentcore-stack.ts to match setup-env.ts expectations
  }

  /**
   * Grant EventBridge Scheduler permission to invoke this Lambda
   */
  public grantInvokeToScheduler(): iam.Grant {
    return this.lambdaFunction.grantInvoke(new iam.ServicePrincipal('scheduler.amazonaws.com'));
  }

  /**
   * Create IAM role for EventBridge Scheduler to invoke this Lambda
   */
  public createSchedulerRole(scope: Construct, _resourcePrefix: string): iam.Role {
    const schedulerRole = new iam.Role(scope, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Role for EventBridge Scheduler to invoke Trigger Lambda',
    });

    // Grant permission to invoke the Lambda function
    this.lambdaFunction.grantInvoke(schedulerRole);

    // Note: CfnOutput is defined in agentcore-stack.ts to match setup-env.ts expectations

    return schedulerRole;
  }
}
