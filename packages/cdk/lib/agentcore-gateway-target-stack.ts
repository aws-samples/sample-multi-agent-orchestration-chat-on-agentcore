import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { AgentCoreLambdaTarget } from './constructs/agentcore';
import { EnvironmentConfig } from '../config';
import * as path from 'path';

export interface AgentCoreGatewayTargetStackProps extends cdk.StackProps {
  /**
   * Environment configuration
   */
  readonly envConfig: EnvironmentConfig;

  /**
   * Gateway ARN (direct specification)
   * Takes precedence over coreStackName import.
   */
  readonly gatewayArn?: string;

  /**
   * Gateway ID (required when gatewayArn is specified)
   */
  readonly gatewayId?: string;

  /**
   * Gateway Name (required when gatewayArn is specified)
   */
  readonly gatewayName?: string;

  /**
   * Gateway Role ARN (required when gatewayArn is specified)
   */
  readonly gatewayRoleArn?: string;

  /**
   * AgentCoreStack name to import Gateway attributes from via Fn::ImportValue
   * Used when gatewayArn is not directly specified.
   */
  readonly coreStackName?: string;

  /**
   * S3 server access logs bucket (optional)
   * When set, enables server access logging for S3 buckets in this stack
   */
  readonly serverAccessLogsBucket?: s3.IBucket;
}

/**
 * AgentCore Gateway Target Stack
 *
 * Independently deployable stack for managing Gateway targets (Lambda Tools, etc.).
 *
 * This stack is separated from the core AgentCoreStack to split the deployment unit,
 * enabling each target to be added, updated, or removed independently without
 * affecting core infrastructure (Gateway, Cognito, Runtime, Storage, etc.).
 *
 * Gateway connection methods:
 * - coreStackName: Cross-stack reference via Fn::ImportValue (same account/region)
 * - Direct attributes (gatewayArn, gatewayId, etc.): Connect to externally managed Gateways
 */
export class AgentCoreGatewayTargetStack extends cdk.Stack {
  /**
   * Utility Tools Lambda Target (echo, ping — always deployed)
   */
  public readonly utilityToolsTarget: AgentCoreLambdaTarget;

  /**
   * Knowledge Base Tools Lambda Target.
   * Undefined when envConfig.knowledgeBaseIds is not configured.
   */
  public readonly kbToolsTarget: AgentCoreLambdaTarget | undefined;

  /**
   * Athena Tools Lambda Target.
   * Undefined when envConfig.athenaSourceBuckets is not configured.
   */
  public readonly athenaToolsTarget: AgentCoreLambdaTarget | undefined;

  /**
   * Tavily Tools Lambda Target.
   * Undefined when envConfig.tavilyApiKeySecretName is not configured.
   */
  public readonly tavilyToolsTarget: AgentCoreLambdaTarget | undefined;

  /**
   * Nova Canvas Tools Lambda Target
   */
  public readonly novaCanvasToolsTarget: AgentCoreLambdaTarget;

  /**
   * Nova Reel Tools Lambda Target
   */
  public readonly novaReelToolsTarget: AgentCoreLambdaTarget;

  /**
   * S3 bucket for Athena query results.
   * Undefined when envConfig.athenaSourceBuckets is not configured.
   */
  public readonly athenaOutputBucket: s3.Bucket | undefined;

  constructor(scope: Construct, id: string, props: AgentCoreGatewayTargetStackProps) {
    super(scope, id, props);

    const envConfig = props.envConfig;
    const resourcePrefix = envConfig.resourcePrefix;

    // Resolve Gateway attributes (direct specification or cross-stack import)
    const gatewayArn = props.gatewayArn || this.importValue(props.coreStackName, 'GatewayArn');
    const gatewayId = props.gatewayId || this.importValue(props.coreStackName, 'GatewayId');
    const gatewayName = props.gatewayName || this.importValue(props.coreStackName, 'GatewayName');
    const gatewayRoleArn =
      props.gatewayRoleArn || this.importValue(props.coreStackName, 'GatewayRoleArn');

    // Import Gateway using L2 fromGatewayAttributes
    const importedGateway = agentcore.Gateway.fromGatewayAttributes(this, 'ImportedGateway', {
      gatewayArn,
      gatewayId,
      gatewayName,
      role: iam.Role.fromRoleArn(this, 'ImportedGatewayRole', gatewayRoleArn),
    });

    // ── Tool Naming Convention ──
    // AgentCore Gateway automatically composes the final tool name visible to agents as:
    //
    //   {targetName}__{toolName}
    //
    // For example:
    //   targetName: 'utility-tools',  toolName: 'echo'  → 'utility-tools__echo'
    //   targetName: 'knowledge-base-tools', toolName: 'retrieve' → 'knowledge-base-tools__retrieve'
    //   targetName: 'athena-tools', toolName: 'execute_query' → 'athena-tools__execute_query'
    //
    // Therefore:
    //   - `targetName` in AgentCoreLambdaTarget props = the namespace/service prefix
    //   - `name` in tool-schema.json and the Tool object = the action name only (no prefix)
    //
    // When changing either targetName or tool names, verify the composed name
    // remains descriptive and unambiguous for agents consuming the Gateway.

    // ── Utility Tools Target ──
    this.utilityToolsTarget = new AgentCoreLambdaTarget(this, 'UtilityToolsTarget', {
      resourcePrefix,
      targetName: 'utility-tools',
      description: 'Lambda function providing utility tools',
      lambdaCodePath: 'packages/lambda-tools/tools/utility-tools',
      toolSchemaPath: 'packages/lambda-tools/tools/utility-tools/tool-schema.json',
      timeout: 30,
      memorySize: 256,
      environment: { LOG_LEVEL: 'INFO' },
    });
    this.utilityToolsTarget.addToImportedGateway(importedGateway, 'UtilityToolsGatewayTarget');
    // Note: bedrock:Retrieve is NOT granted here — it lives in the separate KbToolsTarget (opt-in).

    // ── Knowledge Base Tools Target (opt-in: requires knowledgeBaseIds in environment config) ──
    // KB Tools Lambda is only deployed when knowledgeBaseIds is explicitly configured.
    // This avoids granting bedrock:Retrieve on knowledge-base/* (all KBs in the account).
    if (envConfig.knowledgeBaseIds && envConfig.knowledgeBaseIds.length > 0) {
      const kbResourceArns = envConfig.knowledgeBaseIds.map(
        (kbId) => `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/${kbId}`
      );

      this.kbToolsTarget = new AgentCoreLambdaTarget(this, 'KbToolsTarget', {
        resourcePrefix,
        targetName: 'knowledge-base-tools',
        description: 'Lambda function providing Knowledge Base search tools',
        lambdaCodePath: 'packages/lambda-tools/tools/kb-tools',
        toolSchemaPath: 'packages/lambda-tools/tools/kb-tools/tool-schema.json',
        timeout: 30,
        memorySize: 256,
        environment: { LOG_LEVEL: 'INFO' },
      });
      this.kbToolsTarget.addToImportedGateway(importedGateway, 'KbToolsGatewayTarget');

      // bedrock:Retrieve scoped to configured KB ARNs only
      this.kbToolsTarget.lambdaFunction.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'BedrockKnowledgeBaseRetrieve',
          actions: ['bedrock:Retrieve'],
          resources: kbResourceArns,
        })
      );

      new cdk.CfnOutput(this, 'KbToolsLambdaArn', {
        value: this.kbToolsTarget.lambdaFunction.functionArn,
        description: 'Knowledge Base Tools Lambda Function ARN',
      });

      new cdk.CfnOutput(this, 'KbToolsLambdaName', {
        value: this.kbToolsTarget.lambdaFunction.functionName,
        description: 'Knowledge Base Tools Lambda Function Name',
      });
    }

    // ── Athena Tools Target (opt-in: requires athenaSourceBuckets in environment config) ──
    // Athena Tools Lambda is only deployed when athenaSourceBuckets is explicitly configured.
    // This avoids deploying broad S3 read permissions (Resource:*) in environments where
    // Athena queries are not needed.

    // Resolve server access logs bucket (used by AthenaOutputBucket when created)
    let serverAccessLogsBucket: s3.IBucket | undefined = props.serverAccessLogsBucket;
    if (!serverAccessLogsBucket && props.coreStackName) {
      const logsBucketName = cdk.Fn.importValue(`${props.coreStackName}-AccessLogsBucketName`);
      serverAccessLogsBucket = s3.Bucket.fromBucketName(
        this,
        'ImportedAccessLogsBucket',
        logsBucketName
      );
    }

    if (envConfig.athenaSourceBuckets && envConfig.athenaSourceBuckets.length > 0) {
      // Create S3 bucket for Athena query results
      this.athenaOutputBucket = new s3.Bucket(this, 'AthenaOutputBucket', {
        bucketName: `${resourcePrefix}-athena-output-${this.account}-${this.region}`,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        serverAccessLogsBucket: serverAccessLogsBucket,
        serverAccessLogsPrefix: serverAccessLogsBucket ? 'athena-output/' : undefined,
      });

      this.athenaToolsTarget = new AgentCoreLambdaTarget(this, 'AthenaToolsTarget', {
        resourcePrefix,
        targetName: 'athena-tools',
        description: 'Lambda function providing Athena S3 query tools',
        lambdaCodePath: 'packages/lambda-tools/tools/athena-tools',
        toolSchemaPath: 'packages/lambda-tools/tools/athena-tools/tool-schema.json',
        timeout: 180,
        memorySize: 512,
        environment: {
          LOG_LEVEL: 'INFO',
          ATHENA_WORKGROUP: 'primary',
          ATHENA_OUTPUT_BUCKET: this.athenaOutputBucket.bucketName,
          ALLOWED_DATABASES: '*',
          ALLOWED_TABLES: '*',
        },
      });
      this.athenaToolsTarget.addToImportedGateway(importedGateway, 'AthenaToolsGatewayTarget');

      // Athena query execution permissions (scoped to 'primary' workgroup)
      this.athenaToolsTarget.lambdaFunction.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'AthenaQueryExecution',
          actions: [
            'athena:StartQueryExecution',
            'athena:GetQueryExecution',
            'athena:GetQueryResults',
            'athena:StopQueryExecution',
          ],
          resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/primary`],
        })
      );

      // Glue Data Catalog read permissions (all databases and tables)
      this.athenaToolsTarget.lambdaFunction.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'GlueCatalogRead',
          actions: [
            'glue:GetDatabase',
            'glue:GetDatabases',
            'glue:GetTable',
            'glue:GetTables',
            'glue:GetPartitions',
          ],
          resources: [
            `arn:aws:glue:${this.region}:${this.account}:catalog`,
            `arn:aws:glue:${this.region}:${this.account}:database/*`,
            `arn:aws:glue:${this.region}:${this.account}:table/*/*`,
          ],
        })
      );

      // S3 read permissions scoped to the configured source locations only.
      // When a prefix is specified, object access is restricted to that prefix path.
      // Trailing slash is normalized away before appending /* to prevent double-slash
      // and unintended prefix matches (e.g., 'analytics/sales' matching 'analytics/sales-extra/').
      // The bucket ARN itself is always needed for s3:ListBucket and s3:GetBucketLocation.
      const sourceBucketResources = envConfig.athenaSourceBuckets.flatMap((source) => {
        const bucketArn = `arn:aws:s3:::${source.bucket}`;
        const objectArn = source.prefix
          ? `arn:aws:s3:::${source.bucket}/${source.prefix.replace(/\/+$/, '')}/*`
          : `arn:aws:s3:::${source.bucket}/*`;
        return [bucketArn, objectArn];
      });
      this.athenaToolsTarget.lambdaFunction.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'AthenaS3SourceRead',
          actions: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
          resources: sourceBucketResources,
        })
      );

      // Athena query results S3 permissions (output bucket)
      this.athenaOutputBucket.grantReadWrite(this.athenaToolsTarget.lambdaFunction);

      // Athena Tools outputs
      new cdk.CfnOutput(this, 'AthenaToolsLambdaArn', {
        value: this.athenaToolsTarget.lambdaFunction.functionArn,
        description: 'Athena Tools Lambda Function ARN',
      });

      new cdk.CfnOutput(this, 'AthenaToolsLambdaName', {
        value: this.athenaToolsTarget.lambdaFunction.functionName,
        description: 'Athena Tools Lambda Function Name',
      });

      new cdk.CfnOutput(this, 'AthenaOutputBucketName', {
        value: this.athenaOutputBucket.bucketName,
        description: 'S3 Bucket for Athena query results',
      });

      // Athena Tools: Glue database/*, table/*/* (catalog structure is dynamic)
      // S3 access is scoped to configured athenaSourceBuckets.
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        [`/${id}/AthenaToolsTarget/Function/ServiceRole/DefaultPolicy/Resource`],
        [
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'Glue database/* and table/*/* are required because the Glue catalog structure (database/table names) is determined by user data, not deploy-time config. S3 access is scoped to configured athenaSourceBuckets.',
          },
        ]
      );

      // Suppress S1 for AthenaOutputBucket when no log bucket is available
      if (!serverAccessLogsBucket) {
        NagSuppressions.addResourceSuppressionsByPath(
          this,
          [`/${id}/AthenaOutputBucket/Resource`],
          [
            {
              id: 'AwsSolutions-S1',
              reason:
                'Server access logging is not configured when no log bucket is provided from the core stack.',
            },
          ]
        );
      }
    }

    // ── Tavily Tools Target (opt-in: requires tavilyApiKeySecretName in environment config) ──
    // Tavily Tools Lambda is only deployed when tavilyApiKeySecretName is explicitly
    // configured. This isolates `secretsmanager:GetSecretValue` for the Tavily API key
    // inside a dedicated Lambda execution role, keeping the AgentCore Runtime role clean.
    if (envConfig.tavilyApiKeySecretName) {
      this.tavilyToolsTarget = new AgentCoreLambdaTarget(this, 'TavilyToolsTarget', {
        resourcePrefix,
        targetName: 'tavily-tools',
        description: 'Lambda function providing Tavily web search/extract/crawl tools',
        lambdaCodePath: 'packages/lambda-tools/tools/tavily-tools',
        toolSchemaPath: 'packages/lambda-tools/tools/tavily-tools/tool-schema.json',
        // timeout: tavily_crawl has an upper bound of 150s on the Tavily API side, and
        // extract uses up to 60s. We allow 180s to cover the crawl case + network overhead.
        timeout: 180,
        // memorySize: large Tavily responses (crawl with multiple pages) can be several MB,
        // so 512 MB provides a comfortable margin for JSON parsing + string formatting.
        memorySize: 512,
        environment: {
          LOG_LEVEL: 'INFO',
          TAVILY_API_KEY_SECRET_NAME: envConfig.tavilyApiKeySecretName,
        },
      });
      this.tavilyToolsTarget.addToImportedGateway(importedGateway, 'TavilyToolsGatewayTarget');

      // Secrets Manager access scoped to the configured Tavily API key secret only.
      // The `-*` suffix restricts the permission to the Secrets Manager 6-char random
      // suffix pattern (`arn:...:secret:NAME-abcdef`), preventing accidental access to
      // differently-named secrets that share the same prefix (e.g., `NAME-extra`).
      this.tavilyToolsTarget.lambdaFunction.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'TavilySecretsManagerRead',
          actions: ['secretsmanager:GetSecretValue'],
          resources: [
            `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${envConfig.tavilyApiKeySecretName}-*`,
          ],
        })
      );

      new cdk.CfnOutput(this, 'TavilyToolsLambdaArn', {
        value: this.tavilyToolsTarget.lambdaFunction.functionArn,
        description: 'Tavily Tools Lambda Function ARN',
      });

      new cdk.CfnOutput(this, 'TavilyToolsLambdaName', {
        value: this.tavilyToolsTarget.lambdaFunction.functionName,
        description: 'Tavily Tools Lambda Function Name',
      });
    }

    // ── Nova Canvas Tools Target ──

    // Resolve User Storage bucket name from core stack
    const userStorageBucketName = props.coreStackName
      ? cdk.Fn.importValue(`${props.coreStackName}-UserStorageBucketName`)
      : '';

    this.novaCanvasToolsTarget = new AgentCoreLambdaTarget(this, 'NovaCanvasToolsTarget', {
      resourcePrefix,
      targetName: 'nova-canvas-tools',
      description: 'Lambda function providing Nova Canvas image generation tools',
      lambdaCodePath: 'packages/lambda-tools/tools/nova-canvas-tools',
      toolSchemaPath: 'packages/lambda-tools/tools/nova-canvas-tools/tool-schema.json',
      timeout: 120,
      memorySize: 512,
      environment: {
        LOG_LEVEL: 'INFO',
        NOVA_CANVAS_REGION: 'us-east-1',
        USER_STORAGE_BUCKET_NAME: userStorageBucketName,
      },
      // Forward the Cognito ID Token to the interceptor Lambda so it can resolve identityId.
      // The interceptor uses this ID Token (not the Access Token) for GetId.
      allowedRequestHeaders: ['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token'],
    });
    this.novaCanvasToolsTarget.addToImportedGateway(
      importedGateway,
      'NovaCanvasToolsGatewayTarget'
    );

    // Bedrock InvokeModel permission for Nova Canvas
    this.novaCanvasToolsTarget.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
          'arn:aws:bedrock:*::foundation-model/amazon.nova-canvas-v1:0',
        ],
      })
    );

    // S3 write permission for user storage
    this.novaCanvasToolsTarget.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [`arn:aws:s3:::${userStorageBucketName}/*`],
      })
    );

    // Nova Canvas Tools outputs
    new cdk.CfnOutput(this, 'NovaCanvasToolsLambdaArn', {
      value: this.novaCanvasToolsTarget.lambdaFunction.functionArn,
      description: 'Nova Canvas Tools Lambda Function ARN',
    });

    new cdk.CfnOutput(this, 'NovaCanvasToolsLambdaName', {
      value: this.novaCanvasToolsTarget.lambdaFunction.functionName,
      description: 'Nova Canvas Tools Lambda Function Name',
    });

    // ── Nova Reel Tools Target ──

    this.novaReelToolsTarget = new AgentCoreLambdaTarget(this, 'NovaReelToolsTarget', {
      resourcePrefix,
      targetName: 'nova-reel-tools',
      description: 'Lambda function providing Nova Reel video generation tools',
      lambdaCodePath: 'packages/lambda-tools/tools/nova-reel-tools',
      toolSchemaPath: 'packages/lambda-tools/tools/nova-reel-tools/tool-schema.json',
      timeout: 900,
      memorySize: 512,
      environment: {
        LOG_LEVEL: 'INFO',
        NOVA_REEL_REGION: 'us-east-1',
        USER_STORAGE_BUCKET_NAME: userStorageBucketName,
      },
      // Forward the Cognito ID Token to the interceptor Lambda so it can resolve identityId.
      allowedRequestHeaders: ['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token'],
    });
    this.novaReelToolsTarget.addToImportedGateway(importedGateway, 'NovaReelToolsGatewayTarget');

    // Bedrock async invocation permissions for Nova Reel
    this.novaReelToolsTarget.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:StartAsyncInvoke', 'bedrock:GetAsyncInvoke'],
        resources: [
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
          'arn:aws:bedrock:*::foundation-model/amazon.nova-reel-v1:1',
          `arn:aws:bedrock:*:${this.account}:async-invoke/*`,
        ],
      })
    );

    // bedrock:ListAsyncInvokes is a list-level action and does not support
    // resource-level permissions, so it requires Resource: "*".
    this.novaReelToolsTarget.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:ListAsyncInvokes'],
        resources: ['*'],
      })
    );

    // S3 permissions for Nova Reel (temp output + user storage copy)
    this.novaReelToolsTarget.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject', 's3:CopyObject', 's3:HeadObject'],
        resources: [`arn:aws:s3:::${userStorageBucketName}/*`],
      })
    );

    // Nova Reel Tools outputs
    new cdk.CfnOutput(this, 'NovaReelToolsLambdaArn', {
      value: this.novaReelToolsTarget.lambdaFunction.functionArn,
      description: 'Nova Reel Tools Lambda Function ARN',
    });

    new cdk.CfnOutput(this, 'NovaReelToolsLambdaName', {
      value: this.novaReelToolsTarget.lambdaFunction.functionName,
      description: 'Nova Reel Tools Lambda Function Name',
    });

    // ── OneDrive (Microsoft Graph) OpenAPI Target ──
    // Conditionally created only when OAuth provider ARN and secret ARN are configured
    if (envConfig.microsoftGraphOAuthProviderArn && envConfig.microsoftGraphOAuthSecretArn) {
      const oneDriveSchema = agentcore.ApiSchema.fromLocalAsset(
        path.join(__dirname, '..', 'schemas', 'microsoft-graph-onedrive.json')
      );

      const oneDriveTarget = agentcore.GatewayTarget.forOpenApi(this, 'OneDriveOpenApiTarget', {
        gateway: importedGateway,
        gatewayTargetName: 'onedrive',
        description:
          'Microsoft Graph API target for OneDrive file operations (list, upload, download, search, delete)',
        apiSchema: oneDriveSchema,
        credentialProviderConfigurations: [
          agentcore.GatewayCredentialProvider.fromOauthIdentityArn({
            providerArn: envConfig.microsoftGraphOAuthProviderArn,
            secretArn: envConfig.microsoftGraphOAuthSecretArn,
            scopes: ['https://graph.microsoft.com/.default'],
          }),
        ],
      });

      new cdk.CfnOutput(this, 'OneDriveTargetId', {
        value: oneDriveTarget.targetId,
        description: 'OneDrive OpenAPI Gateway Target ID',
      });

      new cdk.CfnOutput(this, 'OneDriveTargetArn', {
        value: oneDriveTarget.targetArn,
        description: 'OneDrive OpenAPI Gateway Target ARN',
      });
    }

    // CloudFormation outputs
    new cdk.CfnOutput(this, 'GatewayArn', {
      value: gatewayArn,
      description: 'Connected AgentCore Gateway ARN',
    });

    new cdk.CfnOutput(this, 'UtilityToolsLambdaArn', {
      value: this.utilityToolsTarget.lambdaFunction.functionArn,
      description: 'Utility Tools Lambda Function ARN',
    });

    new cdk.CfnOutput(this, 'UtilityToolsLambdaName', {
      value: this.utilityToolsTarget.lambdaFunction.functionName,
      description: 'Utility Tools Lambda Function Name',
    });

    // Tags
    cdk.Tags.of(this).add('Project', 'AgentCore');
    cdk.Tags.of(this).add('Component', 'GatewayTargets');

    // ── cdk-nag Suppressions ──

    // Stack-level suppressions for non-controllable CDK-generated resources
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSLambdaBasicExecutionRole is the standard managed policy for Lambda functions to write CloudWatch Logs.',
      },
      {
        id: 'AwsSolutions-L1',
        reason:
          'NodejsFunction uses NODEJS_22_X which is the latest available runtime. cdk-nag may not recognize it as the latest.',
      },
    ]);

    // ── Per-resource IAM5 suppressions ──
    // CDK internal Custom Resource provider framework generates wildcard policies
    // that cannot be controlled from application code.
    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'CDK internal Custom Resource provider framework generates wildcard policies (logs:*, lambda:*) that are not directly controllable from application code.',
          appliesTo: ['Resource::*', 'Action::logs:*', 'Action::lambda:*'],
        },
      ],
      true
    );

    // ImportedGatewayRole inline Policy: Lambda ARN:* suffix for version/alias invocation.
    // When addToImportedGateway is called, the L2 construct adds an inline policy
    // (named Policy<hash>) to the imported role allowing lambda:InvokeFunction on ARN:*.
    // The policy logical ID contains a CDK token hash and cannot be predicted at synth time,
    // so we use addStackSuppressions with a regex appliesTo pattern.
    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Gateway role requires lambda:InvokeFunction on function ARN:* to support Lambda version and alias invocations when targets are added. This pattern is generated by the AgentCore L2 CDK construct.',
          appliesTo: [{ regex: '/^Resource::<.+\\.Arn>:\\*$/' }],
        },
      ],
      true
    );

    // Nova Canvas Tools: Bedrock inference-profile/* (cross-region inference)
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/NovaCanvasToolsTarget/Function/ServiceRole/DefaultPolicy/Resource`],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'bedrock:InvokeModel requires inference-profile/* for cross-region inference profile support. User storage bucket /* is required for S3 object-level writes.',
        },
      ]
    );

    // Nova Reel Tools: Bedrock inference-profile/*, async-invoke/* (async model invocation)
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [`/${id}/NovaReelToolsTarget/Function/ServiceRole/DefaultPolicy/Resource`],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'bedrock:StartAsyncInvoke/GetAsyncInvoke requires async-invoke/* because async invocation IDs are generated at runtime. inference-profile/* supports cross-region inference. bedrock:ListAsyncInvokes is a list-level action that does not support resource-level permissions and requires Resource: "*". User storage bucket /* is required for video output writes.',
        },
      ]
    );

    // Tavily Tools: Secrets Manager `-*` suffix wildcard (auto-generated 6-char random suffix)
    // AWS Secrets Manager appends a 6-character random suffix to every secret ARN at creation
    // time (e.g., `arn:...:secret:NAME-abcdef`), so a wildcard is mandatory to scope the policy
    // to the exact configured secret name. The policy is NOT wildcarded across secrets — it is
    // narrowed to the single `${tavilyApiKeySecretName}-*` prefix defined in environments.ts.
    if (envConfig.tavilyApiKeySecretName) {
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        [`/${id}/TavilyToolsTarget/Function/ServiceRole/DefaultPolicy/Resource`],
        [
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'Secrets Manager appends an auto-generated 6-character random suffix to every secret ARN, so scoping secretsmanager:GetSecretValue to the exact configured Tavily API key secret requires a "-*" suffix wildcard on the ARN. The resource is already narrowed to the single configured secret name prefix, not wildcarded across all secrets.',
          },
        ]
      );
    }
  }

  /**
   * Import a value from another stack's CfnOutput exports
   */
  private importValue(coreStackName: string | undefined, outputKey: string): string {
    if (!coreStackName) {
      throw new Error(
        `Either direct Gateway attributes or coreStackName must be provided. Missing value for: ${outputKey}`
      );
    }
    return cdk.Fn.importValue(`${coreStackName}-${outputKey}`);
  }
}
