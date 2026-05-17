/**
 * Cognito Identity Pool Construct
 *
 * Provides per-user temporary AWS credentials via Cognito Identity Pool federation.
 *
 * Per-user isolation is enforced by the IAM policy variable
 * ${cognito-identity.amazonaws.com:sub}, which resolves to the Identity Pool
 * identityId (format: "REGION:uuid") in both Resource ARNs and Condition blocks
 * when credentials are issued via GetCredentialsForIdentity.
 *
 * ## Why group-based role switching is not implemented
 *
 * Cognito Identity Pool supports per-group role switching via `roleMappings`
 * (type: 'Token'), which reads the `cognito:preferred_role` claim from the ID Token.
 * However, configuring ANY `roleMappings` on the Identity Pool causes AWS to reject
 * `GetOpenIdTokenForDeveloperIdentity` calls with:
 *
 *   "roleMappings are not supported for developer authenticated identities"
 *
 * `GetOpenIdTokenForDeveloperIdentity` is required by the Trigger Lambda to issue
 * per-user OpenID tokens for event-driven (non-frontend) agent invocations.
 * Therefore, `roleMappings` is intentionally omitted and a single `authenticatedRole`
 * is used for all authenticated users.
 *
 * If per-group role switching is needed in the future, consider:
 *   - Using a separate Identity Pool without a developer provider (no Trigger Lambda support)
 *   - Application-level role assumption after credential exchange
 */

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import type { CognitoAuth } from './cognito-auth';

export interface CognitoIdentityPoolProps {
  readonly cognitoAuth: CognitoAuth;
  readonly resourcePrefix: string;
  /** User Storage S3 bucket name */
  readonly userStorageBucketName: string;
  /** Sessions DynamoDB table ARN */
  readonly sessionsTableArn: string;
  /**
   * AgentCore Memory ARN.
   *
   * Used to scope per-user access to short-term events and long-term memory records
   * via `bedrock-agentcore:actorId` (StringEquals) and `bedrock-agentcore:namespace`
   * (StringLike) conditions bound to `${cognito-identity.amazonaws.com:sub}`.
   */
  readonly agentCoreMemoryArn: string;

  /**
   * Developer provider name for Developer Authenticated Identities.
   * Allows Trigger Lambda to obtain an OpenID Token per user via
   * GetOpenIdTokenForDeveloperIdentity (unavailable in event-driven flows).
   * Convention: "{resourcePrefix}.trigger"
   * @default undefined (feature disabled)
   */
  readonly developerProviderName?: string;
}

// ── Policy Builder Functions ────────────────────────────────────────────────

/**
 * Per-user S3 object access scoped to users/{identityId}/*.
 */
function buildUserStoragePolicies(
  bucketName: string,
  identityPoolSubVariable: string
): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: 'S3UserStorageObjectAccess',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:HeadObject'],
      resources: [`arn:aws:s3:::${bucketName}/users/${identityPoolSubVariable}/*`],
    }),
    new iam.PolicyStatement({
      sid: 'S3UserStorageListAccess',
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [`arn:aws:s3:::${bucketName}`],
      conditions: {
        StringLike: {
          's3:prefix': [`users/${identityPoolSubVariable}/*`, `users/${identityPoolSubVariable}`],
        },
      },
    }),
  ];
}

/**
 * Per-user DynamoDB sessions access scoped to partition key = identityId.
 */
function buildSessionsPolicies(
  sessionsTableArn: string,
  identityPoolSubVariable: string
): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: 'DynamoDBSessionsAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
      ],
      resources: [sessionsTableArn, `${sessionsTableArn}/index/*`],
      conditions: {
        'ForAllValues:StringEquals': {
          'dynamodb:LeadingKeys': [identityPoolSubVariable],
        },
      },
    }),
  ];
}

/**
 * Per-user AgentCore Memory access.
 *
 * Short-term events (CreateEvent / ListEvents / etc.) are scoped by
 * `bedrock-agentcore:actorId` (StringEquals) = `${cognito-identity.amazonaws.com:sub}`.
 *
 * Long-term memory records (ListMemoryRecords / RetrieveMemoryRecords /
 * BatchCreateMemoryRecords) are scoped by `bedrock-agentcore:namespace`
 * (StringLike) matching `/strategies/<any>/actors/<identityId>` (and deeper paths).
 *
 * GetMemoryRecord / DeleteMemoryRecord are intentionally NOT granted:
 *   - As of 2026-05, AWS IAM exposes NO resource-level condition keys
 *     for these two actions. Attaching a namespace StringLike condition
 *     causes silent denial on every call; attaching none would grant any
 *     authenticated user the ability to read/delete any other user's
 *     record given a recordId.
 *   - The product has removed individual record deletion from the UI;
 *     AgentCore's automated lifecycle management is the only way records
 *     are removed. Revisit once AWS adds condition key support.
 *
 * Meta-plane (GetMemory) is NOT granted here — the semantic strategyId is
 * resolved at CDK deploy time (AwsCustomResource) and injected as the
 * `AGENTCORE_SEMANTIC_STRATEGY_ID` environment variable, so neither Runtime
 * nor Backend needs GetMemory at request time.
 *
 * IMPLEMENTATION NOTE: The AWS public documentation example uses
 * `bedrock-agentcore:namespacePath` for namespace-based scoping, but empirical
 * testing against `RetrieveMemoryRecords` / `ListMemoryRecords` showed that
 * `namespacePath` does not match at evaluation time and results in
 * AccessDenied on legitimate requests. `bedrock-agentcore:namespace` +
 * StringLike is the working form.
 */

function buildAgentCoreMemoryPolicies(
  memoryArn: string,
  identityPoolSubVariable: string
): iam.PolicyStatement[] {
  return [
    // (a) Event / Session ops — scoped by actorId
    new iam.PolicyStatement({
      sid: 'AgentCoreMemoryEventPerActor',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:CreateEvent',
        'bedrock-agentcore:ListEvents',
        'bedrock-agentcore:GetEvent',
        'bedrock-agentcore:DeleteEvent',
        'bedrock-agentcore:ListSessions',
        'bedrock-agentcore:ListActors',
      ],
      resources: [memoryArn],
      conditions: {
        StringEquals: {
          'bedrock-agentcore:actorId': identityPoolSubVariable,
        },
      },
    }),
    // (b) Memory record ops — scoped by namespace (StringLike).
    // GetMemoryRecord / DeleteMemoryRecord are intentionally excluded; see the
    // function-level JSDoc for the rationale.
    new iam.PolicyStatement({
      sid: 'AgentCoreMemoryRecordsPerActor',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:RetrieveMemoryRecords',
        'bedrock-agentcore:ListMemoryRecords',
        'bedrock-agentcore:BatchCreateMemoryRecords',
      ],
      resources: [memoryArn],
      conditions: {
        StringLike: {
          'bedrock-agentcore:namespace': [
            `/strategies/*/actors/${identityPoolSubVariable}`,
            `/strategies/*/actors/${identityPoolSubVariable}/*`,
          ],
        },
      },
    }),
    // NOTE: Intentionally no meta-plane grant (GetMemory / ListMemoryStrategies).
    // The semantic strategyId is resolved at deploy time by an AwsCustomResource
    // and delivered to Runtime / Backend via AGENTCORE_SEMANTIC_STRATEGY_ID env
    // var, so neither role needs to call GetMemory at runtime.
  ];
}

// ── Construct ────────────────────────────────────────────────────────────────

export class CognitoIdentityPool extends Construct {
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly identityPoolId: string;
  /** Standard authenticated role — scoped to per-user S3 and DynamoDB access */
  public readonly authenticatedRole: iam.Role;

  constructor(scope: Construct, id: string, props: CognitoIdentityPoolProps) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;

    // ── Identity Pool ──────────────────────────────────────────────────────
    this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: `${props.resourcePrefix.replace(/-/g, '_')}_identity_pool`,
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: props.cognitoAuth.clientId,
          providerName: `cognito-idp.${region}.amazonaws.com/${props.cognitoAuth.userPoolId}`,
          serverSideTokenCheck: true,
        },
      ],
      ...(props.developerProviderName && {
        developerProviderName: props.developerProviderName,
      }),
    });

    this.identityPoolId = this.identityPool.ref;

    const identityPoolSubVariable = '${cognito-identity.amazonaws.com:sub}';

    // ── Authenticated Role ─────────────────────────────────────────────────
    this.authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
      roleName: `${props.resourcePrefix}-identity-pool-auth-${region}`,
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': this.identityPool.ref },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
      description:
        'Role assumed by authenticated users via Cognito Identity Pool - scoped to per-user S3 and DynamoDB access',
      maxSessionDuration: cdk.Duration.hours(1),
    });

    for (const stmt of [
      ...buildUserStoragePolicies(props.userStorageBucketName, identityPoolSubVariable),
      ...buildSessionsPolicies(props.sessionsTableArn, identityPoolSubVariable),
      ...buildAgentCoreMemoryPolicies(props.agentCoreMemoryArn, identityPoolSubVariable),
    ]) {
      this.authenticatedRole.addToPolicy(stmt);
    }

    // ── Identity Pool Role Attachment ──────────────────────────────────────
    // Default authenticated role only — no roleMappings.
    //
    // roleMappings is intentionally omitted because AWS rejects
    // GetOpenIdTokenForDeveloperIdentity calls when any roleMappings are
    // configured on the Identity Pool (regardless of mapping type).
    // This API is required by the Trigger Lambda to issue per-user OpenID tokens.
    // See the file-level comment for details on why group-based role switching
    // is not implemented.
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: this.identityPool.ref,
      roles: { authenticated: this.authenticatedRole.roleArn },
    });

    // ── CloudFormation Outputs ─────────────────────────────────────────────
    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: this.identityPoolId,
      description: 'Cognito Identity Pool ID',
      exportName: `${cdk.Stack.of(this).stackName}-IdentityPoolId`,
    });

    new cdk.CfnOutput(this, 'AuthenticatedRoleArn', {
      value: this.authenticatedRole.roleArn,
      description: 'Cognito Identity Pool Authenticated Role ARN',
      exportName: `${cdk.Stack.of(this).stackName}-IdentityPoolAuthRoleArn`,
    });

    cdk.Tags.of(this.identityPool).add('Component', 'CognitoIdentityPool');
    cdk.Tags.of(this.authenticatedRole).add('Component', 'CognitoIdentityPool');
  }
}
