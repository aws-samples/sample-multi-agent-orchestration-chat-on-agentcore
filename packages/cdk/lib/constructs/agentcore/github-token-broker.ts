/**
 * GitHub Token Broker Lambda Construct
 *
 * Creates a dedicated Lambda that holds the only `secretsmanager:GetSecretValue`
 * permission on the GitHub PAT secret. The AgentCore Runtime execution role is
 * granted `lambda:InvokeFunction` scoped to this broker ARN (via
 * `grantInvoke`) instead of direct Secrets Manager access, shrinking the
 * blast-radius of a sandbox escape in the agent container to this single
 * secret.
 *
 * The broker is intentionally NOT wired up as an AgentCore Gateway Target —
 * only the entrypoint script (`packages/agent/scripts/startup.sh`) calls it.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

const PROJECT_ROOT = path.resolve(process.cwd(), '../..');

export interface GitHubTokenBrokerProps {
  /**
   * Resource name prefix (Lambda function name: `{prefix}-github-token-broker`).
   */
  readonly resourcePrefix: string;

  /**
   * Secrets Manager secret name that stores the GitHub PAT.
   * Baked into the broker Lambda's environment variable and IAM policy.
   */
  readonly githubTokenSecretName: string;

  /**
   * CloudWatch Logs retention (default: 1 week).
   */
  readonly logRetention?: logs.RetentionDays;
}

export class GitHubTokenBroker extends Construct {
  public readonly lambdaFunction: nodejs.NodejsFunction;

  /**
   * ARN of the broker Lambda, to be consumed by the Runtime construct as the
   * sole resource of its `lambda:InvokeFunction` statement.
   */
  public readonly functionArn: string;

  private readonly githubTokenSecretName: string;

  constructor(scope: Construct, id: string, props: GitHubTokenBrokerProps) {
    super(scope, id);

    this.githubTokenSecretName = props.githubTokenSecretName;

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    const logGroup = new logs.LogGroup(this, 'FunctionLogGroup', {
      logGroupName: `/aws/lambda/${props.resourcePrefix}-github-token-broker`,
      retention: props.logRetention ?? logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.lambdaFunction = new nodejs.NodejsFunction(this, 'Function', {
      functionName: `${props.resourcePrefix}-github-token-broker`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(PROJECT_ROOT, 'packages/github-token-broker/src/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      description: 'Returns the GitHub PAT from a single fixed Secrets Manager secret',
      logGroup,
      environment: {
        NODE_ENV: 'production',
        GITHUB_TOKEN_SECRET_NAME: props.githubTokenSecretName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
      },
    });

    // The `${name}-*` suffix matches the 6-char random suffix AWS appends to
    // the secret ARN. It scopes the permission to *exactly one* secret name
    // (differently-named secrets sharing the same prefix, e.g. `NAME-extra`,
    // do not match).
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'GetGitHubTokenSecret',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${region}:${account}:secret:${props.githubTokenSecretName}-*`,
        ],
      })
    );

    this.functionArn = this.lambdaFunction.functionArn;
  }

  /**
   * Add a resource-based policy on the broker Lambda that allows the given
   * role ARN to invoke it.
   *
   * The identity-side `lambda:InvokeFunction` statement is added separately
   * inside `AgentCoreRuntime` (`InvokeGitHubTokenBroker` sid) so the
   * Runtime's IAM surface is auditable from a single file. Here we only own
   * the resource-based policy, which pins the allowed Principal to a
   * specific role ARN and rejects any other caller in the same account.
   */
  public allowInvocationBy(role: iam.IRole): void {
    this.lambdaFunction.addPermission('AllowAgentCoreRuntimeInvoke', {
      principal: new iam.ArnPrincipal(role.roleArn),
      action: 'lambda:InvokeFunction',
    });
  }

  /**
   * Expose the secret name for logging / tagging. Does NOT expose the secret
   * value itself — that lives in Secrets Manager.
   */
  public get secretName(): string {
    return this.githubTokenSecretName;
  }
}
