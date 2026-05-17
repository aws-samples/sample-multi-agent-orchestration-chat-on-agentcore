/**
 * User Storage Construct
 * Provides per-user file storage (S3)
 */

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface UserStorageProps {
  /**
   * Bucket name prefix (optional)
   * Actual bucket name: {prefix}-user-storage-{account}-{region}
   */
  readonly bucketNamePrefix?: string;

  /**
   * Cognito Identity Pool Authenticated Role ARN pattern (optional)
   * When set, the S3 bucket policy Deny rule uses this pattern to scope the
   * DenyS3ObjectAccessOutsideUserScopedPrefix condition to the Identity Pool role.
   * Format: arn:aws:iam::{account}:assumed-role/{roleName}/*
   * @default uses the legacy *-user-scoped-* pattern (for backward compatibility)
   */
  readonly identityPoolAuthRoleArnPattern?: string;

  /**
   * Data retention period (days)
   * @default 365 days (1 year)
   */
  readonly retentionDays?: number;

  /**
   * CORS allowed origins
   * @default ['*'] (for development)
   */
  readonly corsAllowedOrigins?: string[];

  /**
   * S3 bucket removal policy
   * @default RETAIN
   */
  readonly removalPolicy?: cdk.RemovalPolicy;

  /**
   * S3 bucket auto delete (only effective when RemovalPolicy.DESTROY)
   * @default false
   */
  readonly autoDeleteObjects?: boolean;

  /**
   * S3 server access logs bucket (optional)
   * When set, enables server access logging to this bucket
   */
  readonly serverAccessLogsBucket?: s3.IBucket;
}

/**
 * User Storage Construct
 * Provides S3 bucket and access control for user files
 */
export class UserStorage extends Construct {
  /**
   * Created S3 bucket
   */
  public readonly bucket: s3.Bucket;

  /**
   * Bucket name
   */
  public readonly bucketName: string;

  /**
   * Bucket ARN
   */
  public readonly bucketArn: string;

  constructor(scope: Construct, id: string, props?: UserStorageProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const prefix = props?.bucketNamePrefix || 'agentcore';
    const retentionDays = props?.retentionDays || 365;
    const corsAllowedOrigins = props?.corsAllowedOrigins || ['*'];
    const removalPolicy = props?.removalPolicy || cdk.RemovalPolicy.RETAIN;
    const autoDeleteObjects = props?.autoDeleteObjects ?? false;

    // Create S3 bucket
    this.bucket = new s3.Bucket(this, 'UserStorageBucket', {
      bucketName: `${prefix}-user-storage-${stack.account}-${stack.region}`,
      // Enable EventBridge notifications (required for S3 → EventBridge event rules)
      eventBridgeEnabled: true,
      // Security settings
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true, // Enable versioning
      enforceSSL: true, // Enforce SSL/TLS connections

      // Server access logging (S1)
      serverAccessLogsBucket: props?.serverAccessLogsBucket,
      serverAccessLogsPrefix: props?.serverAccessLogsBucket ? 'user-storage/' : undefined,

      // Lifecycle settings
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          noncurrentVersionExpiration: cdk.Duration.days(30), // Delete old versions after 30 days
        },
        {
          id: 'ExpireDeleteMarkers',
          expiredObjectDeleteMarker: true, // Auto-delete delete markers
        },
      ],

      // Removal policy settings
      removalPolicy: removalPolicy,
      autoDeleteObjects: autoDeleteObjects,

      // CORS settings (for direct upload from frontend)
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
            s3.HttpMethods.DELETE,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: corsAllowedOrigins,
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag', 'x-amz-version-id'],
          maxAge: 3000,
        },
      ],
    });

    this.bucketName = this.bucket.bucketName;
    this.bucketArn = this.bucket.bucketArn;

    // S3 bucket policy: enforce per-user prefix isolation via Cognito Identity Pool.
    //
    // The AgentCore Runtime calls GetCredentialsForIdentity using the Cognito ID Token
    // forwarded by the frontend. The resulting credentials assume the Identity Pool
    // Authenticated Role, which includes IAM policy variables restricting S3 access to
    // users/${cognito-idp.REGION.amazonaws.com/POOL_ID:sub}/*
    //
    // This Deny statement provides a defense-in-depth layer: it blocks object-level
    // requests from the Identity Pool role session to any S3 key that does NOT fall
    // under the pattern matched by `identityPoolAuthRoleArnPattern`.
    //
    // The Identity Pool Authenticated Role's own policy already restricts access using
    // the IAM policy variable ${cognito-idp.REGION.amazonaws.com/POOL_ID:sub}, so this
    // bucket policy acts as a second layer of defense.
    //
    // Note: The legacy *-user-scoped-* pattern is kept for backward compatibility with
    // the Backend API's BackendUserScopedS3Role (which is not migrated in this change).
    const principalPatterns: string[] = [];

    if (props?.identityPoolAuthRoleArnPattern) {
      // New: Cognito Identity Pool Authenticated Role pattern
      principalPatterns.push(props.identityPoolAuthRoleArnPattern);
    } else {
      // Legacy: STS UserScopedRole pattern (for backward compatibility / local dev)
      principalPatterns.push(`arn:aws:iam::${stack.account}:assumed-role/*-user-scoped-*/user-*`);
    }

    // NOTE: CDK does not have a first-class API for NotResource in bucket policies.
    // We use addToResourcePolicy with the `notResources` option.
    //
    // For Identity Pool credentials, the IAM policy variable ${cognito-identity.amazonaws.com:sub}
    // is correctly expanded in bucket policy NotResource ARNs, providing per-user isolation
    // at the S3 bucket policy level as a defence-in-depth layer.
    // This means even if the role policy were misconfigured, the bucket policy Deny would
    // prevent any authenticated session from accessing another user's prefix.
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyS3ObjectAccessOutsideUserScopedPrefix',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        // Note: s3:HeadObject is NOT a valid action in S3 resource-based policies.
        // HEAD Object requests are covered by s3:GetObject.
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        // Deny access to any key outside the caller's own users/{identityId}/ prefix.
        // ${cognito-identity.amazonaws.com:sub} resolves to the Identity Pool sub (identityId)
        // at request time — this is the correct variable for GetCredentialsForIdentity sessions.
        notResources: [`${this.bucket.bucketArn}/users/\${cognito-identity.amazonaws.com:sub}/*`],
        conditions: {
          // Apply only to sessions assuming the Identity Pool Authenticated Role.
          // CDK deploy roles, Lambda tools, etc. are excluded by this ArnLike condition.
          ArnLike: {
            'aws:PrincipalArn': principalPatterns,
          },
        },
      })
    );

    // Add tags
    cdk.Tags.of(this.bucket).add('Component', 'UserStorage');
    cdk.Tags.of(this.bucket).add('RetentionDays', retentionDays.toString());
  }

  /**
   * Grant full S3 access to Lambda function
   * Per-user prefix restrictions are implemented at application level
   */
  public grantFullAccess(grantee: iam.IGrantable): iam.Grant {
    return this.bucket.grantReadWrite(grantee);
  }

  /**
   * Grant presigned URL generation permission to Lambda function
   */
  public grantPresignedUrlGeneration(grantee: iam.IGrantable): iam.Grant {
    return this.bucket.grantReadWrite(grantee);
  }

  /**
   * Grant read-only permission to Lambda function
   */
  public grantReadOnly(grantee: iam.IGrantable): iam.Grant {
    return this.bucket.grantRead(grantee);
  }
}
