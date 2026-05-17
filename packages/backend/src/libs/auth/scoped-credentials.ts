/**
 * User-scoped AWS credentials for the backend.
 *
 * Two authentication strategies coexist in this file because each AWS surface
 * requires a different IAM context that cannot be satisfied by the other:
 *
 * - Identity Pool strategy (AgentCore Memory):
 *   AgentCore Memory enforces per-user isolation via `bedrock-agentcore:actorId`
 *   and `bedrock-agentcore:namespace` condition keys that only resolve correctly
 *   when the caller assumes the Cognito Identity Pool Authenticated Role via
 *   `GetCredentialsForIdentity`. The `${cognito-identity.amazonaws.com:sub}`
 *   policy variable is the anchor for all per-user conditions.
 *
 * - STS AssumeRole + session policy strategy (S3):
 *   The S3 prefix `users/{identityId}/` is restricted at call time via an inline
 *   session policy so the role definition itself stays generic. Using a session
 *   policy avoids proliferating per-user roles or inflating the trust policy.
 *
 * Both strategies mint short-lived credentials scoped to the current caller and
 * share the expiry handling / credential-shape adaptation implemented below.
 */

import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
  type Credentials as CognitoCredentials,
} from '@aws-sdk/client-cognito-identity';
import {
  STSClient,
  AssumeRoleCommand,
  type Credentials as StsCredentials,
} from '@aws-sdk/client-sts';
import { S3Client } from '@aws-sdk/client-s3';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import type { IdentityId } from '@moca/core';

import { config } from '../../config/index.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

function isFresh(expiresAt: number): boolean {
  return expiresAt - Date.now() > EXPIRY_MARGIN_MS;
}

/**
 * Normalize the two AWS credential shapes (Cognito uses `SecretKey`, STS uses
 * `SecretAccessKey`) into the form accepted by the AWS SDK client constructors.
 */
function toAwsClientCredentials(creds: {
  AccessKeyId?: string;
  SecretKey?: string;
  SecretAccessKey?: string;
  SessionToken?: string;
}): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } {
  const accessKeyId = creds.AccessKeyId;
  const secretAccessKey = creds.SecretKey ?? creds.SecretAccessKey;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS credentials are missing required fields');
  }
  return { accessKeyId, secretAccessKey, sessionToken: creds.SessionToken };
}

// ---------------------------------------------------------------------------
// Identity Pool strategy — AgentCore Memory
// ---------------------------------------------------------------------------

let cognitoIdentityClient: CognitoIdentityClient | undefined;

function getCognitoIdentityClient(): CognitoIdentityClient {
  if (!cognitoIdentityClient) {
    cognitoIdentityClient = new CognitoIdentityClient({ region: config.AWS_REGION });
  }
  return cognitoIdentityClient;
}

interface IdentityPoolCacheEntry {
  credentials: CognitoCredentials;
  identityId: string;
  expiresAt: number;
}

/**
 * Keyed by ID Token so that every authenticated session reuses the same
 * short-lived credentials until they expire. identity-resolver.ts caches the
 * identityId independently; we store it here too to avoid a second GetId call.
 */
const identityPoolCache = new Map<string, IdentityPoolCacheEntry>();

function getIdTokenFromRequest(req: AuthenticatedRequest): string {
  const idToken = req.get('X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token');
  if (!idToken) {
    throw new Error('X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token header is required');
  }
  return idToken;
}

async function getIdentityPoolCredentials(
  req: AuthenticatedRequest
): Promise<IdentityPoolCacheEntry> {
  const idToken = getIdTokenFromRequest(req);

  const cached = identityPoolCache.get(idToken);
  if (cached && isFresh(cached.expiresAt)) {
    return cached;
  }

  const identityPoolId = config.IDENTITY_POOL_ID;
  const userPoolId = config.COGNITO_USER_POOL_ID;
  const region = config.AWS_REGION;

  const loginsKey = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  const logins = { [loginsKey]: idToken };
  const client = getCognitoIdentityClient();

  const { IdentityId } = await client.send(
    new GetIdCommand({ IdentityPoolId: identityPoolId, Logins: logins })
  );
  if (!IdentityId) throw new Error('GetId did not return an IdentityId');

  const { Credentials } = await client.send(
    new GetCredentialsForIdentityCommand({ IdentityId, Logins: logins })
  );
  if (!Credentials?.AccessKeyId || !Credentials.SecretKey) {
    throw new Error('GetCredentialsForIdentity did not return valid credentials');
  }

  const entry: IdentityPoolCacheEntry = {
    credentials: Credentials,
    identityId: IdentityId,
    expiresAt: Credentials.Expiration?.getTime() ?? Date.now() + 60 * 60 * 1000,
  };
  identityPoolCache.set(idToken, entry);
  return entry;
}

/**
 * Create a BedrockAgentCoreClient bound to the caller's Identity Pool credentials.
 */
export async function createAgentCoreClient(
  req: AuthenticatedRequest
): Promise<BedrockAgentCoreClient> {
  const { credentials } = await getIdentityPoolCredentials(req);
  return new BedrockAgentCoreClient({
    region: config.AWS_REGION,
    credentials: toAwsClientCredentials(credentials),
  });
}

// ---------------------------------------------------------------------------
// STS AssumeRole strategy — S3
// ---------------------------------------------------------------------------

let stsClient: STSClient | undefined;

function getStsClient(): STSClient {
  if (!stsClient) {
    stsClient = new STSClient({ region: config.AWS_REGION });
  }
  return stsClient;
}

interface AssumedRoleCacheEntry {
  credentials: StsCredentials;
  expiresAt: number;
}

const assumedRoleCache = new Map<IdentityId, AssumedRoleCacheEntry>();

const S3_SESSION_DURATION_SECONDS = 900;

function buildS3SessionPolicy(bucketName: string, identityId: IdentityId): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowObjectAccessUserPrefix',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:HeadObject'],
        Resource: `arn:aws:s3:::${bucketName}/users/${identityId}/*`,
      },
      {
        Sid: 'AllowListBucketUserPrefix',
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: `arn:aws:s3:::${bucketName}`,
        Condition: {
          StringLike: {
            's3:prefix': [`users/${identityId}/*`, `users/${identityId}`],
          },
        },
      },
    ],
  });
}

async function getS3ScopedCredentials(identityId: IdentityId): Promise<StsCredentials> {
  const roleArn = config.USER_SCOPED_ROLE_ARN;
  const bucketName = config.USER_STORAGE_BUCKET_NAME;
  if (!roleArn) throw new Error('USER_SCOPED_ROLE_ARN is not set');

  const cached = assumedRoleCache.get(identityId);
  if (cached && isFresh(cached.expiresAt)) {
    return cached.credentials;
  }

  // STS requires the session name to match [\w+=,.@-]; identityId contains ':'.
  const roleSessionName = `backend-${identityId.replace(/[^a-zA-Z0-9_=,.@-]/g, '_').slice(0, 48)}`;

  const response = await getStsClient().send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: roleSessionName,
      Policy: buildS3SessionPolicy(bucketName, identityId),
      DurationSeconds: S3_SESSION_DURATION_SECONDS,
    })
  );

  if (!response.Credentials) throw new Error('STS AssumeRole did not return credentials');

  assumedRoleCache.set(identityId, {
    credentials: response.Credentials,
    expiresAt:
      response.Credentials.Expiration?.getTime() ?? Date.now() + S3_SESSION_DURATION_SECONDS * 1000,
  });

  return response.Credentials;
}

/**
 * Create an S3Client restricted to `users/{identityId}/` via an STS session policy.
 */
export async function createScopedS3Client(identityId: IdentityId): Promise<S3Client> {
  const credentials = await getS3ScopedCredentials(identityId);
  return new S3Client({
    region: config.AWS_REGION,
    credentials: toAwsClientCredentials(credentials),
  });
}
