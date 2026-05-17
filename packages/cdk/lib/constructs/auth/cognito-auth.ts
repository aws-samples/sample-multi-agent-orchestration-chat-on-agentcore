import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';

/**
 * Repo root. cdk is always invoked from `packages/cdk/`, so two levels up reaches
 * the monorepo root. Used to resolve Lambda `entry` paths consistently with the
 * other constructs in this package (see backend-api.ts, frontend.ts, etc.).
 */
const PROJECT_ROOT = path.resolve(process.cwd(), '../..');

export interface CognitoAuthProps {
  /**
   * Cognito User Pool name
   */
  readonly userPoolName: string;

  /**
   * Cognito User Pool Domain prefix.
   *
   * Globally unique across all AWS accounts and regions.
   * Validated and supplied by environments.ts (see EnvironmentConfig.cognitoDomainPrefix).
   */
  readonly domainPrefix: string;

  /**
   * App Client name
   * @default "{userPoolName}-client"
   */
  readonly appClientName?: string;

  /**
   * Password policy minimum length
   * @default 8
   */
  readonly passwordMinLength?: number;

  /**
   * Enable user deletion protection
   * @default false (for development)
   */
  readonly deletionProtection?: boolean;

  /**
   * Additional User Pool configuration
   */
  readonly userPoolConfig?: {
    readonly mfa?: cognito.Mfa;
    readonly selfSignUpEnabled?: boolean;
    readonly autoVerify?: {
      email?: boolean;
      phone?: boolean;
    };
  };

  /**
   * List of allowed email domains for sign up (optional)
   * When set, only email addresses from these domains can sign up
   * Example: ['amazon.com', 'amazon.jp']
   */
  readonly allowedSignUpEmailDomains?: string[];
}

/**
 * Cognito User Pool + App Client Construct for AgentCore
 *
 * Provides Cognito authentication foundation shared by Gateway and Runtime.
 */
export class CognitoAuth extends Construct {
  /**
   * Created User Pool
   */
  public readonly userPool: cognito.UserPool;

  /**
   * Created App Client
   */
  public readonly userPoolClient: cognito.UserPoolClient;

  /**
   * OIDC Discovery URL
   * Used for AgentCore JWT authorizer
   */
  public readonly discoveryUrl: string;

  /**
   * App Client ID
   * Used for JWT token client_id claim verification
   */
  public readonly clientId: string;

  /**
   * App Client for Machine User
   * Used for Client Credentials Flow
   */
  public readonly machineUserClient: cognito.UserPoolClient;

  /**
   * App Client ID for Machine User
   */
  public readonly machineUserClientId: string;

  /**
   * Resource Server (OAuth2 scope definition)
   */
  public readonly resourceServer: cognito.UserPoolResourceServer;

  /**
   * User Pool Domain
   * Required for Token endpoint access
   */
  public readonly userPoolDomain: cognito.UserPoolDomain;

  /**
   * User Pool ID
   */
  public readonly userPoolId: string;

  /**
   * User Pool ARN
   */
  public readonly userPoolArn: string;

  constructor(scope: Construct, id: string, props: CognitoAuthProps) {
    super(scope, id);

    // Pre Sign Up Lambda trigger (for email domain validation).
    // The handler source lives in `packages/cdk/lambda/cognito-pre-signup/` and is
    // bundled by NodejsFunction — keeping it on disk (rather than inline) lets
    // eslint / prettier / tsc cover it and makes unit tests possible.
    let preSignUpTrigger: lambda.IFunction | undefined;
    if (props.allowedSignUpEmailDomains && props.allowedSignUpEmailDomains.length > 0) {
      const preSignUpLogGroup = new logs.LogGroup(this, 'PreSignUpTriggerLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      preSignUpTrigger = new nodejs.NodejsFunction(this, 'PreSignUpTrigger', {
        runtime: lambda.Runtime.NODEJS_22_X,
        // ARM64 (Graviton2) — pure Node.js, no native bindings.
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(PROJECT_ROOT, 'packages/cdk/lambda/cognito-pre-signup/index.ts'),
        handler: 'handler',
        timeout: cdk.Duration.seconds(10),
        memorySize: 128,
        environment: {
          ALLOWED_DOMAINS: props.allowedSignUpEmailDomains.join(','),
        },
        logGroup: preSignUpLogGroup,
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'es2022',
          // No runtime deps — `aws-lambda` is a types-only import.
          externalModules: [],
        },
      });
    }

    // Create User Pool
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: props.userPoolName,

      // Password policy
      passwordPolicy: {
        minLength: props.passwordMinLength || 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },

      // MFA settings
      mfa: props.userPoolConfig?.mfa || cognito.Mfa.OFF,

      // Self sign-up
      selfSignUpEnabled: props.userPoolConfig?.selfSignUpEnabled ?? false,

      // Auto verification
      autoVerify: {
        email: props.userPoolConfig?.autoVerify?.email ?? false,
        phone: props.userPoolConfig?.autoVerify?.phone ?? false,
      },

      // Sign-in settings
      signInAliases: {
        username: true,
        email: true,
        phone: false,
      },

      // Deletion protection
      deletionProtection: props.deletionProtection ?? false,

      // Advanced Security (Threat Protection) - always ENFORCED (requires PLUS tier)
      // Note: PLUS tier is set via CfnUserPool escape hatch below (L2 does not expose userPoolTier)
      advancedSecurityMode: cognito.AdvancedSecurityMode.ENFORCED,

      // No custom attributes (simple configuration)
      customAttributes: {},

      // Account recovery
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,

      // Lambda trigger settings
      lambdaTriggers: preSignUpTrigger
        ? {
            preSignUp: preSignUpTrigger,
          }
        : undefined,
    });

    // Set PLUS tier via CfnUserPool escape hatch
    // CDK L2 (aws-cdk-lib 2.x) does not expose userPoolTier on UserPool construct,
    // so we override the CloudFormation property directly.
    const cfnUserPool = this.userPool.node.defaultChild as cognito.CfnUserPool;
    cfnUserPool.addPropertyOverride('UserPoolTier', 'PLUS');

    // cdk-nag can't see the PLUS tier set through `addPropertyOverride`, so it
    // keeps flagging AwsSolutions-COG8. Suppress on this specific resource.
    NagSuppressions.addResourceSuppressions(this.userPool, [
      {
        id: 'AwsSolutions-COG8',
        reason:
          'User Pool is set to PLUS tier via CfnUserPool.addPropertyOverride("UserPoolTier", "PLUS"); cdk-nag does not resolve property overrides.',
      },
    ]);

    // Create App Client
    this.userPoolClient = this.userPool.addClient('AppClient', {
      userPoolClientName: props.appClientName || `${props.userPoolName}-client`,

      // Authentication flow settings
      authFlows: {
        userPassword: true, // USER_PASSWORD_AUTH (required)
        userSrp: true, // Enable SRP authentication
        adminUserPassword: true, // ADMIN_USER_PASSWORD_AUTH
        custom: false, // CUSTOM_AUTH disabled
      },

      // OAuth settings completely removed (not needed for JWT authentication)

      // Token validity
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),

      // Security settings
      generateSecret: false, // Public client (no secret required)
      preventUserExistenceErrors: true,
    });

    // Create Resource Server (OAuth2 scope definition)
    this.resourceServer = new cognito.UserPoolResourceServer(this, 'ResourceServer', {
      userPool: this.userPool,
      identifier: 'agent',
      userPoolResourceServerName: `${props.userPoolName}-resource-server`,
      scopes: [
        {
          scopeName: 'invoke',
          scopeDescription: 'Invoke Agent API',
        },
        {
          scopeName: 'tools',
          scopeDescription: 'Access Gateway tools',
        },
        {
          scopeName: 'admin',
          scopeDescription: 'Administrative access',
        },
      ],
    });

    // Create User Pool Domain (for Token endpoint access).
    //
    // domainPrefix is supplied by environments.ts (EnvironmentConfig.cognitoDomainPrefix)
    // because Cognito domain prefixes share a GLOBAL namespace across all AWS accounts
    // and regions. Auto-derivation from userPoolName + accountId slice cannot guarantee
    // uniqueness, so the decision is delegated to the environment configuration and
    // validated in validateCognitoDomainPrefix() at synth time.
    const domainPrefix = props.domainPrefix;
    this.userPoolDomain = this.userPool.addDomain('Domain', {
      cognitoDomain: {
        domainPrefix,
      },
    });

    // Create App Client for Machine User (Client Credentials Flow)
    this.machineUserClient = this.userPool.addClient('MachineUserClient', {
      userPoolClientName: `${props.userPoolName}-machine`,
      generateSecret: true, // Required for Client Credentials Flow
      authFlows: {
        userPassword: false,
        userSrp: false,
        adminUserPassword: false,
        custom: false,
      },
      oAuth: {
        flows: {
          clientCredentials: true, // Enable Client Credentials Flow
        },
        scopes: [
          cognito.OAuthScope.resourceServer(this.resourceServer, {
            scopeName: 'invoke',
            scopeDescription: 'Invoke Agent API',
          }),
          cognito.OAuthScope.resourceServer(this.resourceServer, {
            scopeName: 'tools',
            scopeDescription: 'Access Gateway tools',
          }),
        ],
      },
      accessTokenValidity: cdk.Duration.hours(1),
      preventUserExistenceErrors: true,
    });

    // Set Machine Client dependencies
    this.machineUserClient.node.addDependency(this.resourceServer);
    this.machineUserClient.node.addDependency(this.userPoolDomain);

    // When deletion protection is disabled (default/dev environments), ensure the
    // UserPool and its dependent resources are destroyed together with the stack.
    // CDK's default RemovalPolicy for UserPool and UserPoolDomain is RETAIN, which
    // leaves stale resources behind after `cdk destroy` and blocks re-creation when
    // the next deploy tries to reuse the same globally unique domainPrefix.
    // App Clients are implicitly deleted with the UserPool, so no explicit policy needed.
    if (!(props.deletionProtection ?? false)) {
      this.userPool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
      this.userPoolDomain.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
      this.resourceServer.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    }

    // Set properties
    this.clientId = this.userPoolClient.userPoolClientId;
    this.machineUserClientId = this.machineUserClient.userPoolClientId;
    this.userPoolId = this.userPool.userPoolId;
    this.userPoolArn = this.userPool.userPoolArn;

    // Build OIDC Discovery URL
    const region = cdk.Stack.of(this).region;
    this.discoveryUrl = `https://cognito-idp.${region}.amazonaws.com/${this.userPoolId}/.well-known/openid-configuration`;

    // CloudFormation Outputs
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: `${cdk.Stack.of(this).stackName}-UserPoolId`,
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.clientId,
      description: 'Cognito User Pool App Client ID',
      exportName: `${cdk.Stack.of(this).stackName}-UserPoolClientId`,
    });

    new cdk.CfnOutput(this, 'DiscoveryUrl', {
      value: this.discoveryUrl,
      description: 'OIDC Discovery URL for JWT authentication',
      exportName: `${cdk.Stack.of(this).stackName}-DiscoveryUrl`,
    });

    new cdk.CfnOutput(this, 'MachineUserClientId', {
      value: this.machineUserClientId,
      description: 'Cognito Machine User App Client ID (for Client Credentials Flow)',
      exportName: `${cdk.Stack.of(this).stackName}-MachineUserClientId`,
    });

    new cdk.CfnOutput(this, 'TokenEndpoint', {
      value: `https://${domainPrefix}.auth.${region}.amazoncognito.com/oauth2/token`,
      description: 'OAuth2 Token Endpoint for Client Credentials Flow',
      exportName: `${cdk.Stack.of(this).stackName}-TokenEndpoint`,
    });

    new cdk.CfnOutput(this, 'DomainPrefix', {
      value: domainPrefix,
      description: 'Cognito User Pool Domain Prefix',
      exportName: `${cdk.Stack.of(this).stackName}-DomainPrefix`,
    });
  }

  /**
   * Get parameters for JWT token verification
   * Used for AgentCore Runtime authorizerConfiguration
   */
  public getJwtAuthorizerConfig(): {
    discoveryUrl: string;
    allowedClients: string[];
  } {
    return {
      discoveryUrl: this.discoveryUrl,
      allowedClients: [this.clientId, this.machineUserClientId], // Regular + Machine User
    };
  }
}
