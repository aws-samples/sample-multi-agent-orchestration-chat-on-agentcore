import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { NodejsBuild, CacheType } from '@cdklabs/deploy-time-build';
import { ComputeType } from 'aws-cdk-lib/aws-codebuild';
import { Construct } from 'constructs';
import * as path from 'path';
import type { BedrockModelConfig } from '../../../config';

/**
 * Get project root directory from CDK package
 * CDK is always run from packages/cdk/, so go 2 levels up to reach repo root.
 */
const PROJECT_ROOT = path.resolve(process.cwd(), '../..');

export interface FrontendProps {
  /**
   * Resource name prefix (optional)
   * S3 bucket name: {resourcePrefix}-frontend-{ACCOUNT}-{REGION}
   * @default 'agentcore'
   */
  readonly resourcePrefix?: string;

  /**
   * Cognito User Pool ID for frontend configuration
   */
  userPoolId: string;

  /**
   * Cognito User Pool Client ID for frontend configuration
   */
  userPoolClientId: string;

  /**
   * AgentCore Runtime Endpoint URL
   */
  runtimeEndpoint: string;

  /**
   * Backend API URL (API Gateway + Lambda)
   */
  backendApiUrl?: string;

  /**
   * AWS Region
   */
  awsRegion: string;

  /**
   * Custom domain configuration (optional)
   */
  customDomain?: {
    /**
     * Hostname (e.g., 'genai')
     */
    hostName: string;

    /**
     * Domain name (e.g., 'example.com')
     */
    domainName: string;
  };

  /**
   * AppSync Events WebSocket endpoint for real-time updates (optional)
   */
  appsyncEventsEndpoint?: string;

  /**
   * Available Bedrock models for frontend model selector (optional)
   */
  bedrockModels?: BedrockModelConfig[];

  /**
   * S3 server access logs bucket (optional)
   * When set, enables server access logging for S3 and CloudFront
   */
  serverAccessLogsBucket?: s3.IBucket;

  /**
   * CloudFront geo restriction - allowlist of ISO 3166-1 alpha-2 country codes (optional)
   * When set, only requests from listed countries are allowed.
   * Example: ['JP', 'US', 'GB']
   * @default undefined (no geo restriction)
   */
  geoRestriction?: string[];

  /**
   * WAF WebACL ARN to attach to CloudFront distribution (optional)
   * The ARN must come from a WebACL created in us-east-1 with scope=CLOUDFRONT.
   * Use WafStack to create the WebACL and pass its ARN here via cross-region references.
   * @default undefined (no WAF)
   */
  webAclArn?: string;

  /**
   * Cognito Identity Pool ID (optional)
   * Passed to the frontend as VITE_IDENTITY_POOL_ID so the browser can
   * call GetCredentialsForIdentity to obtain per-user temporary credentials.
   */
  identityPoolId?: string;

  /**
   * Whether self sign-up is enabled in Cognito User Pool (optional)
   * Controls visibility of the sign-up link in the login screen.
   * @default false
   */
  selfSignUpEnabled?: boolean;
}

export class Frontend extends Construct {
  public readonly s3Bucket: s3.Bucket;
  public readonly cloudFrontDistribution: cloudfront.Distribution;
  public readonly websiteUrl: string;

  constructor(scope: Construct, id: string, props: FrontendProps) {
    super(scope, id);

    // Get resource prefix
    const resourcePrefix = props.resourcePrefix || 'agentcore';

    // Custom domain processing
    let certificate: acm.ICertificate | undefined;
    let domainNames: string[] | undefined;
    let hostedZone: route53.IHostedZone | undefined;
    let fullDomainName: string | undefined;

    if (props.customDomain) {
      const { hostName, domainName } = props.customDomain;
      fullDomainName = `${hostName}.${domainName}`;

      // Lookup Route53 hosted zone (auto-search from domain name)
      hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: domainName,
      });

      // Create ACM certificate (in us-east-1 for CloudFront)
      // Using DnsValidatedCertificate creates certificate in us-east-1 and performs DNS validation automatically
      certificate = new acm.DnsValidatedCertificate(this, 'Certificate', {
        domainName: fullDomainName,
        hostedZone: hostedZone,
        region: 'us-east-1', // CloudFront requires certificate in us-east-1
      });

      domainNames = [fullDomainName];
    }

    // S3 Bucket for Frontend Static Website
    this.s3Bucket = new s3.Bucket(this, 'AgentCoreFrontendBucket', {
      bucketName: `${resourcePrefix}-frontend-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true, // Enforce SSL/TLS connections (S10)
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For demo purposes
      autoDeleteObjects: true, // For demo purposes
      // Server access logging (S1)
      serverAccessLogsBucket: props.serverAccessLogsBucket,
      serverAccessLogsPrefix: props.serverAccessLogsBucket ? 'frontend-s3/' : undefined,
    });

    // Response Headers Policy for optimized caching and security
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      'FrontendResponseHeadersPolicy',
      {
        responseHeadersPolicyName: `${resourcePrefix}-security-headers-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
        comment: 'Security headers policy for AgentCore Frontend',
        // Security headers
        securityHeadersBehavior: {
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            override: true,
          },
          xssProtection: {
            protection: true,
            modeBlock: true,
            override: true,
          },
        },
      }
    );

    // Cache Policy for static assets (JS, CSS, fonts, images)
    const staticAssetsCachePolicy = new cloudfront.CachePolicy(this, 'StaticAssetsCachePolicy', {
      cachePolicyName: `${resourcePrefix}-static-assets-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      comment: 'Cache policy for static assets with long TTL',
      defaultTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.days(365),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    // Create Origin Access Control (OAC) explicitly
    const originAccessControl = new cloudfront.S3OriginAccessControl(this, 'FrontendOAC', {
      originAccessControlName: `${resourcePrefix}-frontend-oac-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      signing: cloudfront.Signing.SIGV4_NO_OVERRIDE,
    });

    // S3 Origin with explicit OAC
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.s3Bucket, {
      originAccessControl: originAccessControl,
    });

    // CloudFront Distribution
    this.cloudFrontDistribution = new cloudfront.Distribution(
      this,
      'AgentCoreCloudFrontDistribution',
      {
        // CloudFront access logging (CFR3)
        logBucket: props.serverAccessLogsBucket,
        logFilePrefix: props.serverAccessLogsBucket ? 'cloudfront/' : undefined,
        defaultBehavior: {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: responseHeadersPolicy,
          compress: true,
        },
        // Static assets behavior (JS, CSS, fonts, images) with aggressive caching
        additionalBehaviors: {
          '/assets/*': {
            origin: s3Origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: staticAssetsCachePolicy,
            responseHeadersPolicy: responseHeadersPolicy,
            compress: true,
          },
        },
        defaultRootObject: 'index.html',
        errorResponses: [
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
            ttl: cdk.Duration.minutes(30),
          },
          {
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
            ttl: cdk.Duration.minutes(30),
          },
        ],
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        // Custom domain settings
        domainNames: domainNames,
        certificate: certificate,
        // Geo restriction (CFR1) - allowlist specific countries when configured
        geoRestriction: props.geoRestriction
          ? cloudfront.GeoRestriction.allowlist(...props.geoRestriction)
          : undefined,
        // WAF WebACL (CFR2) - attach ARN from WafStack (us-east-1) when provided
        webAclId: props.webAclArn,
      }
    );

    // Create Route53 A record (when custom domain is configured)
    if (hostedZone && fullDomainName) {
      new route53.ARecord(this, 'AliasRecord', {
        zone: hostedZone,
        recordName: fullDomainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(this.cloudFrontDistribution)
        ),
      });
    }

    // Frontend Build and Deployment using deploy-time-build
    // Uses multiple assets (include-list pattern) so that only workspace packages
    // required for the frontend build are shipped to the CodeBuild environment.
    // When adding a new workspace dependency for frontend, add a corresponding asset entry below.
    const frontendBuild = new NodejsBuild(this, 'FrontendBuild', {
      assets: [
        {
          path: PROJECT_ROOT,
          exclude: [
            'node_modules/**',
            '.git/**',
            'dist/**',
            '.env',
            '.env.*',
            'cdk.out/**',
            'coverage/**',
            'packages/agent/**',
            'packages/backend/**',
            'packages/cdk/**',
            'packages/lambda-tools/**',
            'packages/trigger/**',
            'packages/session-stream-handler/**',
            'packages/libs/s3-workspace-sync/**',
            'docker/**',
            'docs/**',
            'scripts/**',
            '**/*.tsbuildinfo',
          ],
        },
      ],
      buildCommands: [
        // --prefer-offline: maximise reuse from the S3-backed npm cache (see `cache` below).
        // --no-audit / --no-fund: skip the network calls CodeBuild cannot benefit from.
        // --loglevel=error: cut log I/O on a ~2-3k dependency install.
        'npm ci --include-workspace-root -w packages/frontend -w packages/libs/generative-ui-catalog -w packages/libs/tool-definitions --prefer-offline --no-audit --no-fund --loglevel=error',
        'npm run build -w packages/libs/generative-ui-catalog',
        'npm run build -w packages/frontend',
      ],
      // Vite build is CPU-bound; LARGE (15 GB / 8 vCPU) roughly halves wall time
      // vs the default SMALL (3 GB / 2 vCPU). CodeBuild bills per minute so the
      // unit-price increase is offset by the shorter build.
      computeType: ComputeType.LARGE,
      // Persist the npm cache (~50-200 MB) to S3 so subsequent deploys skip
      // the full `npm ci` download phase. Cache key is derived from
      // package-lock.json, so stale entries are invalidated automatically.
      cache: CacheType.S3,
      buildEnvironment: {
        VITE_COGNITO_USER_POOL_ID: props.userPoolId,
        VITE_COGNITO_CLIENT_ID: props.userPoolClientId,
        VITE_AWS_REGION: props.awsRegion,
        VITE_AGENT_ENDPOINT: props.runtimeEndpoint,
        VITE_BACKEND_URL: props.backendApiUrl || '',
        VITE_APPSYNC_EVENTS_ENDPOINT: props.appsyncEventsEndpoint || '',
        VITE_BEDROCK_MODELS: JSON.stringify(props.bedrockModels ?? []),
        VITE_SELF_SIGN_UP_ENABLED: String(props.selfSignUpEnabled ?? false),
        // Identity Pool ID for GetCredentialsForIdentity calls from the browser
        VITE_IDENTITY_POOL_ID: props.identityPoolId || '',
      },
      outputSourceDirectory: 'packages/frontend/dist',
      destinationBucket: this.s3Bucket,
      distribution: this.cloudFrontDistribution,
      nodejsVersion: 22,
    });

    // Add CloudWatch Logs permissions to NodejsBuild
    iam.Grant.addToPrincipal({
      grantee: frontendBuild,
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resourceArns: [
        `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/codebuild/*`,
        `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/codebuild/*:*`,
      ],
    });

    // Set website URL for easy access
    this.websiteUrl = fullDomainName
      ? `https://${fullDomainName}`
      : `https://${this.cloudFrontDistribution.distributionDomainName}`;
  }
}
