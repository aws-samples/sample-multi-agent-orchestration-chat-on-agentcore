import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { CognitoAuth } from '../auth';
import {
  BedrockModelConfig,
  deriveBedrockIamResources,
  hasBedrockOpenAiModel,
  hasMantleModel,
} from '../../../config';

/**
 * Get project root directory from CDK package
 * CDK is always run from packages/cdk/, so go 2 levels up to reach repo root.
 */
const PROJECT_ROOT = path.resolve(process.cwd(), '../..');
const BACKEND_DIR = path.join(PROJECT_ROOT, 'packages/backend');

const WEB_FUNCTION_RUNTIME = 'nodejs24.x';
const ENDPOINT_NAME = 'main';

export interface BackendApiProps {
  /**
   * API name (also used as the Web Function name)
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
   * Per-request timeout (seconds). Also used as the CloudFront origin read
   * timeout, which is limited to 1–60s without a quota increase.
   * @default 30
   */
  readonly timeout?: number;

  /**
   * Log retention period
   * @default 14 days
   */
  readonly logRetention?: logs.RetentionDays;

  /**
   * Bucket for CloudFront access logs and the code bucket's server access logs
   */
  readonly serverAccessLogsBucket?: s3.IBucket;

  /**
   * Bedrock models allowed for invocation (from bedrockModels environment config).
   * Used to derive scoped IAM resource ARNs for InvokeModel permissions.
   */
  readonly bedrockModels: BedrockModelConfig[];
}

/**
 * AgentCore Backend API Construct
 *
 * Runs the Express app as an AWS Lambda Web Function behind CloudFront.
 * The Web Function endpoint is `IamAuth`; only this distribution (via OAC)
 * can invoke it. Application-level auth (Cognito JWT) is unchanged and is
 * enforced by the Express middleware.
 */
export class BackendApi extends Construct {
  /**
   * Execution role shared by every revision. Grant AWS permissions here.
   */
  public readonly role: iam.Role;

  /**
   * Web Function
   */
  public readonly webFunction: lambda.CfnWebFunction;

  /**
   * Web Function endpoint (origin of the distribution)
   */
  public readonly endpoint: lambda.CfnWebFunctionEndpoint;

  /**
   * CloudFront distribution in front of the Web Function endpoint
   */
  public readonly distribution: cloudfront.Distribution;

  /**
   * Centralized application log group
   */
  public readonly logGroup: logs.LogGroup;

  /**
   * API endpoint URL (no trailing slash; callers append `/path`)
   */
  public readonly apiUrl: string;

  private readonly environment: Record<string, string>;

  constructor(scope: Construct, id: string, props: BackendApiProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const functionName = props.apiName || 'agentcore-backend-api';
    const corsAllowedOrigins = props.corsAllowedOrigins || ['*'];
    const retention = props.logRetention || logs.RetentionDays.TWO_WEEKS;
    const timeoutSeconds = props.timeout ?? 30;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 3 || timeoutSeconds > 60) {
      // Above 60 CloudFront would 504 while the Web Function keeps running (and billing).
      throw new Error(`BackendApi timeout must be an integer 3-60 seconds, got ${timeoutSeconds}`);
    }

    // ── Execution role ──────────────────────────────────────────
    this.role = new iam.Role(this, 'BackendApiExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Bedrock model invocation permissions.
    // Resources are derived from bedrockModels config (SoT) to restrict access to only the configured models.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: deriveBedrockIamResources(props.bedrockModels, stack.region, stack.account),
      })
    );

    // gpt-oss (bedrock-runtime /openai/v1, Chat Completions) bearer-token auth.
    // Mirrors the runtime role: these authenticate InvokeModel with a
    // locally-minted bearer token, gated by bedrock:CallWithBearerToken
    // (Read-level, no resource type → Resource:'*'). gpt-oss only.
    if (hasBedrockOpenAiModel(props.bedrockModels)) {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:CallWithBearerToken'],
          resources: ['*'],
        })
      );
    }

    // gpt-5.x (Bedrock Mantle /openai/v1, Responses API) — SEPARATE bedrock-mantle:
    // service (NOT bedrock:). Mirrors the runtime role and the AWS-managed
    // AmazonBedrockMantleInferenceAccess policy: CreateInference / Get* / List* on
    // the Mantle project resource + its own CallWithBearerToken. gpt-5.x only.
    if (hasMantleModel(props.bedrockModels)) {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'bedrock-mantle:CreateInference',
            'bedrock-mantle:Get*',
            'bedrock-mantle:List*',
          ],
          resources: [`arn:aws:bedrock-mantle:*:${stack.account}:project/*`],
        })
      );
      this.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['bedrock-mantle:CallWithBearerToken'],
          resources: ['*'],
        })
      );
    }

    // NOTE: Intentionally no AgentCore Memory permissions on this execution
    // role. The Backend forwards each user's Cognito ID Token to
    // `cognito-identity:GetCredentialsForIdentity` and constructs a user-scoped
    // BedrockAgentCoreClient, so Memory calls run under the Identity Pool
    // Authenticated Role and are constrained by the per-user
    // `bedrock-agentcore:actorId` / `bedrock-agentcore:namespace` conditions.
    // The strategy id is resolved at deploy time and delivered via
    // AGENTCORE_SEMANTIC_STRATEGY_ID, so `bedrock-agentcore:GetMemory` is not
    // needed here either.

    // ── Log groups ──────────────────────────────────────────────
    // Lambda writes to `<name>.local` in-Region and centralizes into `<name>`.
    // Both are created here (before the revision) so Lambda never auto-creates
    // them without retention, which would also make the next deploy fail with
    // "already exists".
    const logGroupName = `/aws/lambda/web/${functionName}`;
    this.logGroup = new logs.LogGroup(this, 'BackendApiLogGroup', {
      logGroupName,
      retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const localLogGroup = new logs.LogGroup(this, 'BackendApiLocalLogGroup', {
      logGroupName: `${logGroupName}.local`,
      retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Code bucket + bundle ────────────────────────────────────
    // A dedicated bucket instead of the CDK bootstrap asset bucket: Web
    // Functions read the zip as `lambda.amazonaws.com`, which needs a bucket
    // policy grant we must not add to the shared bootstrap bucket.
    const codeBucket = new s3.Bucket(this, 'CodeBucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: props.serverAccessLogsBucket,
      serverAccessLogsPrefix: props.serverAccessLogsBucket ? 'backend-code-bucket/' : undefined,
      // No expiration of *current* objects: deleting the zip behind the live
      // revision fails it permanently, and an unchanged backend can keep one
      // zip current for years. Each deploy with a changed bundle adds one
      // ~1.2 MB object, so growth is negligible. Noncurrent versions only
      // appear when an identical asset is re-uploaded (the revision is then
      // re-pinned to the new version), so expiring them is safe.
      lifecycleRules: [
        {
          id: 'ExpireNoncurrentAndIncomplete',
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    const revisionArnPattern = `arn:aws:lambda:${stack.region}:${stack.account}:web-function/${functionName}/revision/*`;
    const codeBucketPolicy = codeBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowLambdaWebFunctionCodeAccess',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [codeBucket.arnForObjects('*')],
        conditions: { ArnLike: { 'aws:SourceArn': revisionArnPattern } },
      })
    );

    const codeDeployment = new s3deploy.BucketDeployment(this, 'CodeDeployment', {
      destinationBucket: codeBucket,
      sources: [backendBundleSource()],
      extract: false,
      // Old zips stay: deleting the object behind a revision that is still
      // live during the deploy fails it permanently (re-uploading can't fix it).
      prune: false,
      memoryLimit: 512,
    });

    // ── Web Function ────────────────────────────────────────────
    this.environment = {
      NODE_ENV: 'production',

      // Cognito / JWT authentication configuration
      COGNITO_USER_POOL_ID: props.cognitoAuth.userPoolId,
      COGNITO_REGION: stack.region,

      // CORS configuration
      CORS_ALLOWED_ORIGINS: corsAllowedOrigins.join(','),

      // AWS_ACCOUNT_ID is NOT auto-injected by Lambda, so pass it explicitly:
      // SchedulerService assembles the persisted EventBridge Schedule ARN from it.
      AWS_ACCOUNT_ID: stack.account,
      AGENTCORE_GATEWAY_ENDPOINT: props.agentcoreGatewayEndpoint,
      AGENTCORE_MEMORY_ID: props.agentcoreMemoryId || '',
      AGENTCORE_SEMANTIC_STRATEGY_ID: props.agentcoreSemanticStrategyId || '',
      USER_STORAGE_BUCKET_NAME: props.userStorageBucketName || '',

      AGENTS_TABLE_NAME: props.agentsTableName || '',
      SESSIONS_TABLE_NAME: props.sessionsTableName || '',
    };

    this.webFunction = new lambda.CfnWebFunction(this, 'WebFunction', {
      functionName,
      tags: [{ key: 'Component', value: 'BackendApi' }],
    });

    const revision = new lambda.CfnWebFunctionRevision(this, 'Revision', {
      functionName,
      description: 'AgentCore Backend API (Express.js)',
      buildConfig: {
        codeConfig: {
          s3Object: {
            bucket: codeBucket.bucketName,
            key: cdk.Fn.select(0, codeDeployment.objectKeys),
            versionId: cdk.Fn.select(0, codeDeployment.objectVersionIds),
          },
        },
        runtimeConfig: { runtime: WEB_FUNCTION_RUNTIME },
      },
      serviceConfig: {
        executionRoleArn: this.role.roleArn,
        timeoutSeconds,
        environmentVariables: cdk.Lazy.any({ produce: () => ({ ...this.environment }) }),
        telemetryConfig: { loggingConfig: { logGroup: logGroupName } },
      },
    });
    revision.node.addDependency(this.webFunction, codeDeployment);
    revision.node.addDependency(this.logGroup, localLogGroup);
    if (codeBucketPolicy.policyDependable) {
      revision.node.addDependency(codeBucketPolicy.policyDependable);
    }
    // Depending on the Role construct pulls in its DefaultPolicy, so the
    // endpoint never shifts traffic to a revision whose grants aren't attached
    // yet. (lambda.Function adds this implicitly; the L1 revision does not.)
    revision.node.addDependency(this.role);

    this.endpoint = new lambda.CfnWebFunctionEndpoint(this, 'Endpoint', {
      functionName,
      endpointName: ENDPOINT_NAME,
      endpointType: 'HomeRegion',
      // Only the CloudFront distribution below may invoke (resource policy).
      // Never ApplicationManaged: that would make the regional domain
      // publicly reachable and bypass CloudFront.
      authType: 'IamAuth',
      description: 'Backend API endpoint (fronted by CloudFront OAC)',
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
    });
    this.endpoint.addDependency(this.webFunction);

    // ── CloudFront ──────────────────────────────────────────────
    // Authorization (Cognito JWT) must be in the cache key or CloudFront
    // strips it from GET/HEAD. TTL defaults to 0 so nothing is cached unless
    // the app sends Cache-Control; the 1s max is the smallest non-zero value
    // CloudFront accepts when headers are part of the key.
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      comment: 'Backend API: per-Authorization key, no caching by default',
      defaultTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const oac = new cloudfront.FunctionUrlOriginAccessControl(this, 'WebFunctionOac', {
      description: 'OAC for the Backend API Lambda Web Function',
      // The only signing behavior Web Function origins accept; it keeps the
      // viewer's Authorization header intact for JWT verification.
      signing: cloudfront.Signing.SIGV4_ALWAYS_AMZ_AUTH,
    });

    this.distribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      comment: `${functionName} Backend API`,
      defaultBehavior: {
        origin: new origins.HttpOrigin(this.endpoint.attrDomainName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          readTimeout: cdk.Duration.seconds(timeoutSeconds),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: apiCachePolicy,
        // ExceptHost: the endpoint 404s when Host is the distribution's domain.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: true,
      },
      // CloudFront caches 4xx/5xx for 10s by default even without
      // Cache-Control, so a 404 right before a resource is created (or a 503
      // during a cold start) would be replayed. The app also sends no-store;
      // this covers errors CloudFront synthesizes itself.
      errorResponses: [400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504].map((httpStatus) => ({
        httpStatus,
        ttl: cdk.Duration.seconds(0),
      })),
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      logBucket: props.serverAccessLogsBucket,
      logFilePrefix: props.serverAccessLogsBucket ? 'cloudfront-api/' : undefined,
    });
    // HttpOrigin has no OAC option; attach it at the L1 level.
    (this.distribution.node.defaultChild as cloudfront.CfnDistribution).addPropertyOverride(
      'DistributionConfig.Origins.0.OriginAccessControlId',
      oac.originAccessControlId
    );

    new lambda.CfnResourcePolicy(this, 'WebFunctionResourcePolicy', {
      resourceArn: this.webFunction.attrFunctionArn,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowCloudFrontOACAccess',
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 'lambda:InvokeWebFunctionEndpoint',
            Resource: this.endpoint.attrEndpointArn,
            Condition: {
              StringEquals: {
                'aws:SourceArn': this.distribution.distributionArn,
              },
            },
          },
        ],
      },
    });

    this.apiUrl = `https://${this.distribution.distributionDomainName}`;

    cdk.Tags.of(this.role).add('Component', 'BackendApi');
    cdk.Tags.of(this.distribution).add('Component', 'BackendApi');

    NagSuppressions.addResourceSuppressions(
      this.distribution,
      [
        {
          id: 'AwsSolutions-CFR1',
          reason:
            'API is called server-side by AgentCore Runtime and Trigger Lambda as well as browsers; geo restriction would block them. Parity with the previous API Gateway endpoint.',
        },
        {
          id: 'AwsSolutions-CFR2',
          reason:
            'Parity with the previous API Gateway endpoint (no WAF). Every route except /ping and HMAC-verified /webhooks requires a Cognito JWT.',
        },
        {
          id: 'AwsSolutions-CFR4',
          reason:
            'Uses the default *.cloudfront.net certificate, which does not allow pinning the minimum TLS version.',
        },
      ],
      true
    );
  }

  /**
   * Set an environment variable on the Web Function revision
   */
  public addEnvironmentVariable(key: string, value: string): void {
    this.environment[key] = value;
  }

  /**
   * Grant additional IAM permissions to the Backend execution role
   */
  public grantPermissions(statement: iam.PolicyStatement): void {
    this.role.addToPolicy(statement);
  }
}

/**
 * Bundle the Express app into a single ESM file for the Web Function zip.
 * esbuild runs in-process at synth; `npm run build` must have produced the
 * `@moca/*` libs' dist/ first (same prerequisite as `cdk synth`).
 */
function backendBundleSource(): s3deploy.ISource {
  return s3deploy.Source.asset(BACKEND_DIR, {
    assetHashType: cdk.AssetHashType.OUTPUT,
    bundling: {
      // Required by the type but never used: tryBundle always succeeds or
      // throws. A container fallback could not resolve the workspace `@moca/*`
      // libs anyway, since only packages/backend would be mounted.
      image: cdk.DockerImage.fromRegistry('public.ecr.aws/docker/library/node:24-slim'),
      local: {
        tryBundle(outputDir: string): boolean {
          esbuild.buildSync({
            entryPoints: [path.join(BACKEND_DIR, 'src/index.ts')],
            absWorkingDir: BACKEND_DIR,
            bundle: true,
            platform: 'node',
            target: 'node24',
            format: 'esm',
            outfile: path.join(outputDir, 'index.js'),
            // CJS deps (express, ...) call require(); ESM output has none.
            banner: {
              js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
            },
            logLevel: 'warning',
          });
          fs.writeFileSync(
            path.join(outputDir, 'package.json'),
            JSON.stringify({ type: 'module' }, null, 2)
          );
          return true;
        },
      },
    },
  });
}
