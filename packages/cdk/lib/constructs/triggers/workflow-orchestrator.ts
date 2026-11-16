import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

export interface WorkflowOrchestratorProps {
  readonly resourcePrefix: string;
  readonly workflowsTable: dynamodb.ITable;
  readonly agentsTable: dynamodb.ITable;
  readonly agentRuntimeArn: string;
  readonly cognitoDomain: string;
  readonly cognitoClientId: string;
  readonly cognitoClientSecret: string;
  readonly identityPoolId: string;
  readonly developerProviderName: string;
  readonly ssmParameterPrefix: string;
}

/**
 * Multi-agent workflow orchestrator (Lambda durable function).
 *
 * Callers build ARNs from the fixed names below instead of token references:
 * the Backend URL feeds the Runtime, and the Runtime ARN feeds this function,
 * so a token from here into the Backend or Runtime would close a cycle.
 */
export class WorkflowOrchestrator extends Construct {
  public static readonly ALIAS = 'live';

  public static functionNameFor(resourcePrefix: string): string {
    return `${resourcePrefix}-workflow-orchestrator`;
  }

  /** Unqualified function ARN, built without token references. */
  public static functionArnFor(scope: Construct, resourcePrefix: string): string {
    return cdk.Stack.of(scope).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: WorkflowOrchestrator.functionNameFor(resourcePrefix),
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
  }

  public readonly lambdaFunction: nodejs.NodejsFunction;
  public readonly alias: lambda.Alias;

  constructor(scope: Construct, id: string, props: WorkflowOrchestratorProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const functionName = WorkflowOrchestrator.functionNameFor(props.resourcePrefix);

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.lambdaFunction = new nodejs.NodejsFunction(this, 'Function', {
      functionName,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../../../trigger/src/workflow/handler.ts'),
      handler: 'handler',
      // Per replay invocation; waiting on step callbacks costs no invocation time.
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      description: 'Multi-agent workflow orchestrator (durable)',
      logGroup,
      durableConfig: {
        executionTimeout: cdk.Duration.days(7),
        retentionPeriod: cdk.Duration.days(14),
      },
      environment: {
        NODE_ENV: 'production',
        WORKFLOWS_TABLE_NAME: props.workflowsTable.tableName,
        AGENTS_TABLE_NAME: props.agentsTable.tableName,
        SSM_PARAMETER_PREFIX: props.ssmParameterPrefix,
        AGENT_API_URL: `https://bedrock-agentcore.${stack.region}.amazonaws.com/runtimes/${props.agentRuntimeArn}/invocations?qualifier=DEFAULT`,
        COGNITO_DOMAIN: props.cognitoDomain,
        COGNITO_CLIENT_ID: props.cognitoClientId,
        COGNITO_CLIENT_SECRET: props.cognitoClientSecret,
        COGNITO_SCOPE: 'agent/invoke agent/tools',
        IDENTITY_POOL_ID: props.identityPoolId,
        DEVELOPER_PROVIDER_NAME: props.developerProviderName,
      },
      bundling: { minify: true, sourceMap: true, target: 'es2022' },
    });

    // Durable functions must be invoked through a qualified ARN.
    this.alias = new lambda.Alias(this, 'Alias', {
      aliasName: WorkflowOrchestrator.ALIAS,
      version: this.lambdaFunction.currentVersion,
    });

    props.workflowsTable.grantReadWriteData(this.lambdaFunction);
    // GetItem only: the orchestrator never queries agent indexes.
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadAgentDefinitions',
        actions: ['dynamodb:GetItem'],
        resources: [props.agentsTable.tableArn],
      })
    );

    const fnArn = WorkflowOrchestrator.functionArnFor(this, props.resourcePrefix);
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'StopOwnDurableExecutions',
        actions: ['lambda:ListDurableExecutionsByFunction', 'lambda:StopDurableExecution'],
        resources: [fnArn, `${fnArn}:*`],
      })
    );

    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SsmMcpEnvRead',
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmParameterPrefix}/agents/*`,
        ],
      })
    );
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CognitoIdentityDeveloperAuth',
        actions: ['cognito-identity:GetOpenIdTokenForDeveloperIdentity'],
        resources: [
          `arn:aws:cognito-identity:${stack.region}:${stack.account}:identitypool/${props.identityPoolId}`,
        ],
      })
    );

    cdk.Tags.of(this.lambdaFunction).add('Component', 'Workflows');
  }
}
