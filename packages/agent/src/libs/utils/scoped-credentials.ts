/**
 * User-scoped Credentials via Cognito Identity Pool
 *
 * Provides temporary AWS credentials scoped to a specific user's resources via
 * the Cognito Identity Pool Authenticated Role.
 *
 * Architecture:
 *   1. Frontend sends the Cognito ID Token in
 *      X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token
 *   2. middleware/request-context.ts extracts it into RequestContext.idToken
 *   3. This module calls:
 *      a. cognito-identity:GetId(idToken)  → identityId ("REGION:uuid")
 *      b. cognito-identity:GetCredentialsForIdentity(identityId, idToken)
 *         → temporary credentials assuming the Authenticated Role
 *   4. identityId is stored in RequestContext.identityId for use as the S3 prefix
 *      key and DynamoDB partition key.
 *   5. The resulting credentials are used for all user-scoped AWS operations.
 *
 * Key design decision — identityId as storage key:
 *   The IAM policy variable ${cognito-identity.amazonaws.com:sub} (= identityId)
 *   is correctly expanded in BOTH Resource ARNs and Condition blocks when credentials
 *   come from GetCredentialsForIdentity.
 *   The User Pool sub variable (${cognito-idp.REGION.amazonaws.com/POOL_ID:sub})
 *   is NOT expanded by IAM in this context — only works with direct AssumeRoleWithWebIdentity.
 *   Therefore all storage (S3 prefix, DynamoDB partition key) is keyed on identityId.
 *
 * Security properties:
 * - Runtime execution role has NO S3/DynamoDB permissions.
 *   Stolen IMDS credentials cannot access user data.
 * - Per-user isolation enforced at IAM level (Identity Pool role policy +
 *   S3 bucket policy Deny) using ${cognito-identity.amazonaws.com:sub}.
 * - ID Token is validated by AWS (JWKS) on every GetCredentialsForIdentity call.
 */

import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
  type Credentials as CognitoCredentials,
} from '@aws-sdk/client-cognito-identity';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { type IdentityId, parseIdentityId } from '@moca/core';

import { config } from '../../config/index.js';
import { logger } from '../logger/index.js';
import {
  getCallerIdToken,
  getCurrentContext,
  type RequestContext,
} from '../context/request-context.js';
import { decodeJwtExpiryMs } from '../auth/session-token-store.js';

/**
 * No unexpired ID token is known for the session, so user-scoped credentials
 * cannot be (re-)minted. Typed so persistence callers can surface it once per
 * turn instead of logging one warning per message / file.
 */
export class UserCredentialsExpiredError extends Error {
  constructor(message = 'User-scoped credentials expired and no unexpired ID token is available') {
    super(message);
    this.name = 'UserCredentialsExpiredError';
  }
}

/**
 * Cached credentials entry with expiration tracking
 */
interface CachedEntry {
  credentials: CognitoCredentials;
  identityId: IdentityId;
  /** Expiry timestamp in milliseconds */
  expiresAt: number;
}

/**
 * In-memory credential cache keyed by userId.
 * Credentials are reused until they expire (with a safety margin).
 */
const credentialCache = new Map<string, CachedEntry>();

/**
 * Safety margin before credential expiry. Must exceed the SDK's own 5-minute
 * refresh window: with an equal margin the provider could hand the SDK
 * credentials it already considers expired.
 */
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;

/**
 * When the ID token has this little validity left, mint once more with it even
 * if cached credentials are still valid: Identity Pool credentials live 1 h
 * from minting, so a turn whose client never renews the token (closed tab,
 * backgrounded iOS PWA) keeps persisting for ~1 h past the token's expiry
 * instead of stopping when the first credentials run out.
 */
const EARLY_REMINT_WINDOW_MS = 10 * 60 * 1000;

/** Credentials outliving the token by at least this much need no early re-mint. */
const EARLY_REMINT_TARGET_MS = 50 * 60 * 1000;

function canStillExtendWithToken(
  credentialsExpireAt: number,
  idTokenExpiresAt: number | undefined,
  now: number
): idTokenExpiresAt is number {
  return (
    idTokenExpiresAt !== undefined &&
    idTokenExpiresAt > now &&
    credentialsExpireAt - idTokenExpiresAt < EARLY_REMINT_TARGET_MS
  );
}

/** Intended for unit tests only. */
export function resetUserScopedCredentialCache(): void {
  credentialCache.clear();
}

/**
 * Obtain per-user temporary credentials by exchanging the Cognito ID Token
 * for Cognito Identity Pool credentials, and return both the credentials
 * and the resolved identityId.
 *
 * The identityId is stored in the request context so it can be used as the
 * S3 prefix key and DynamoDB partition key.
 *
 * @param userId - The authenticated user's ID (Cognito User Pool sub UUID).
 *                 Used as cache key only; storage is keyed on identityId.
 * @returns Temporary AWS credentials and the resolved identityId.
 */
async function assumeUserScopedRole(
  userId: string,
  context: RequestContext | undefined = getCurrentContext()
): Promise<{ credentials: CognitoCredentials; identityId: IdentityId; expiresAt: number }> {
  const identityPoolId = config.IDENTITY_POOL_ID;
  const userPoolId = config.COGNITO_USER_POOL_ID;
  const region = config.AWS_REGION;

  if (!identityPoolId || !userPoolId) {
    throw new Error(
      'IDENTITY_POOL_ID and COGNITO_USER_POOL_ID must be configured for user-scoped credentials'
    );
  }

  // The freshest token known for the session: a long turn's request-start
  // token expires after 1 h, but the frontend renews it via the side channel.
  const idToken = getCallerIdToken(undefined, context);

  if (!idToken) {
    throw new Error(
      'Cognito ID Token not found in request context. ' +
        'Ensure the frontend sends X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token.'
    );
  }

  // Check cache — reuse if still valid
  const cached = credentialCache.get(userId);
  const now = Date.now();
  const idTokenExpiresAt = decodeJwtExpiryMs(idToken);
  const remintEarly =
    !!cached &&
    canStillExtendWithToken(cached.expiresAt, idTokenExpiresAt, now) &&
    idTokenExpiresAt - now <= EARLY_REMINT_WINDOW_MS;
  if (cached && cached.expiresAt - now > EXPIRY_MARGIN_MS && !remintEarly) {
    logger.debug(`Using cached Identity Pool credentials for user=${userId}`);
    // Ensure identityId is populated in context
    if (context && !context.identityId) {
      context.identityId = cached.identityId;
    }
    return cached;
  }

  if ((idTokenExpiresAt ?? Infinity) <= now) {
    throw new UserCredentialsExpiredError();
  }

  logger.debug(`Obtaining Identity Pool credentials for user=${userId}`);

  const identityClient = new CognitoIdentityClient({ region });

  // Determine the correct Logins key and identityId resolution strategy
  // based on the token type:
  //
  // - Cognito UserPool ID Token (frontend):
  //     iss = "https://cognito-idp.{region}.amazonaws.com/{poolId}"
  //     → key: "cognito-idp.{region}.amazonaws.com/{poolId}"
  //     → identityId: resolved via GetId (required)
  //
  // - Developer Authenticated Identities OpenID Token (Trigger Lambda):
  //     GetOpenIdTokenForDeveloperIdentity returns a short-lived token whose
  //     iss = "https://cognito-identity.amazonaws.com"
  //     → key: "cognito-identity.amazonaws.com"
  //     → identityId: encoded directly in the token's `sub` claim (REGION:UUID)
  //       IMPORTANT: GetId CANNOT accept developer-auth tokens and will throw
  //       NotAuthorizedException: "Invalid login token. Can't pass in a Cognito token."
  //       Skip GetId entirely and use `sub` from the JWT payload as the identityId.
  let loginsKey: string;
  let isDeveloperAuthToken = false;
  let jwtSub: string | undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString());
    isDeveloperAuthToken = !!payload.iss?.includes('cognito-identity.amazonaws.com');
    loginsKey = isDeveloperAuthToken
      ? 'cognito-identity.amazonaws.com'
      : `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
    jwtSub = payload.sub;
  } catch {
    loginsKey = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  }

  const logins = { [loginsKey]: idToken };

  // Step 1: Resolve the Cognito Identity ID for this user.
  //
  // Developer-auth tokens: skip GetId — identityId is the `sub` claim of the JWT.
  // UserPool tokens: call GetId to resolve the identityId from the pool.
  let identityId: IdentityId;
  if (isDeveloperAuthToken) {
    // The developer-auth token's `sub` claim IS the identityId (format: "REGION:UUID").
    // GetId cannot be called with developer-auth tokens — it throws NotAuthorizedException.
    if (!jwtSub) {
      throw new Error('Developer-auth token is missing `sub` claim (identityId)');
    }
    identityId = parseIdentityId(jwtSub);
    logger.debug(`Developer-auth token: using identityId from sub claim: ${identityId}`);
  } else {
    // UserPool token: call GetId to resolve the identityId.
    const getIdResponse = await identityClient.send(
      new GetIdCommand({
        IdentityPoolId: identityPoolId,
        Logins: logins,
      })
    );
    if (!getIdResponse.IdentityId) {
      throw new Error('GetId did not return an IdentityId');
    }
    identityId = parseIdentityId(getIdResponse.IdentityId);
  }

  // Step 2: Exchange Identity ID + ID Token for temporary credentials
  const getCredsResponse = await identityClient.send(
    new GetCredentialsForIdentityCommand({
      IdentityId: identityId,
      Logins: logins,
    })
  );

  const credentials = getCredsResponse.Credentials;
  if (!credentials || !credentials.AccessKeyId || !credentials.SecretKey) {
    throw new Error('GetCredentialsForIdentity did not return valid credentials');
  }

  // Cache the credentials
  const expiresAt = credentials.Expiration
    ? credentials.Expiration.getTime()
    : Date.now() + 60 * 60 * 1000;

  const entry: CachedEntry = { credentials, identityId, expiresAt };
  credentialCache.set(userId, entry);
  // Also index by identityId so callers that already know the identityId
  // (e.g. memory-fetcher, memory-search, session-helper) hit the same cache
  // entry without triggering a second GetId / GetCredentialsForIdentity round-trip.
  if (userId !== identityId) {
    credentialCache.set(identityId, entry);
  }

  // Store identityId in request context for downstream use
  // (S3 prefix construction, DynamoDB partition key)
  if (context) {
    context.identityId = identityId;
  }

  logger.debug(
    `Identity Pool credentials obtained for user=${userId}, ` +
      `identityId=${identityId}, expires=${new Date(expiresAt).toISOString()}`
  );

  // NOTE: Linking the developer login to the Identity Pool identity is the
  // sole responsibility of the Backend API (`packages/backend/src/libs/auth/
  // identity-resolver.ts`). The Agent must NOT call
  // `GetOpenIdTokenForDeveloperIdentity` here, because for Trigger Lambda
  // requests this `loginsKey` is already `cognito-identity.amazonaws.com`
  // (developer provider) — adding `developerProviderName` would put two
  // developer providers in `Logins`, which Cognito rejects with
  // `InvalidParameterException`.

  return entry;
}

/** Structurally the SDK's AwsCredentialIdentity (avoids a direct @smithy/types dependency). */
interface UserScopedIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration: Date;
}
type UserScopedIdentityProvider = () => Promise<UserScopedIdentity>;

/**
 * A provider (not static keys) so the SDK re-invokes it when fewer than
 * 5 minutes of validity remain. The request context is captured at client
 * creation because the SDK may resolve credentials outside the original
 * AsyncLocalStorage scope.
 */
function userScopedCredentialProvider(
  userId: string,
  context: RequestContext | undefined
): UserScopedIdentityProvider {
  return async (): Promise<UserScopedIdentity> => {
    const { credentials, expiresAt } = await assumeUserScopedRole(userId, context);
    // Ask the SDK to come back while the token can still mint (see
    // EARLY_REMINT_WINDOW_MS); otherwise it would wait for the credentials.
    const idTokenExpiresAt = decodeJwtExpiryMs(getCallerIdToken(undefined, context));
    const refreshBy = canStillExtendWithToken(expiresAt, idTokenExpiresAt, Date.now())
      ? Math.min(expiresAt, idTokenExpiresAt)
      : expiresAt;
    return {
      accessKeyId: credentials.AccessKeyId!,
      secretAccessKey: credentials.SecretKey!,
      sessionToken: credentials.SessionToken,
      expiration: new Date(refreshBy),
    };
  };
}

/** Resolve once eagerly so identityId lands in the context, then hand out a refreshing provider. */
async function resolveProvider(userId: string): Promise<UserScopedIdentityProvider> {
  const context = getCurrentContext();
  await assumeUserScopedRole(userId, context);
  return userScopedCredentialProvider(userId, context);
}

/**
 * Create an S3Client configured with user-scoped temporary credentials.
 *
 * @param userId - The authenticated user's ID (Cognito User Pool sub UUID).
 * @returns S3Client that can only access `users/{identityId}/` in the storage bucket.
 */
export async function createUserScopedS3Client(userId: string): Promise<S3Client> {
  return new S3Client({
    region: config.AWS_REGION,
    credentials: await resolveProvider(userId),
  });
}

/**
 * Create a DynamoDBClient configured with user-scoped temporary credentials.
 *
 * @param userId - The authenticated user's ID (Cognito User Pool sub UUID).
 * @returns DynamoDBClient scoped to the user's DynamoDB partition key (identityId).
 */
export async function createUserScopedDynamoDBClient(userId: string): Promise<DynamoDBClient> {
  return new DynamoDBClient({
    region: config.AWS_REGION,
    credentials: await resolveProvider(userId),
  });
}

/**
 * Create a BedrockAgentCoreClient configured with user-scoped Identity Pool credentials.
 *
 * Used for AgentCore Memory data-plane operations (CreateEvent / ListEvents /
 * RetrieveMemoryRecords / etc.) where per-user isolation is enforced via
 * `bedrock-agentcore:actorId` / `bedrock-agentcore:namespace` conditions on the
 * Authenticated Role.
 *
 * @param userId - The authenticated user's ID (Cognito User Pool sub UUID).
 */
export async function createUserScopedBedrockAgentCoreClient(
  userId: string
): Promise<BedrockAgentCoreClient> {
  return new BedrockAgentCoreClient({
    region: config.AWS_REGION,
    credentials: await resolveProvider(userId),
  });
}

// NOTE: No control-plane client (`BedrockAgentCoreControlClient`) is exposed
// here because the semantic memory strategyId is resolved at CDK deploy time
// (via an AwsCustomResource that calls `GetMemory`) and supplied to the
// runtime via the `AGENTCORE_SEMANTIC_STRATEGY_ID` env var. The runtime does
// not need to call any control-plane API.

/**
 * Whether user-scoped credentials are usable now or can still be re-minted
 * (an unexpired ID token is known for the session). Lets bulk persistence
 * (workspace sync) skip work that would fail once per item.
 */
export function canObtainUserScopedCredentials(
  userId: string,
  context: RequestContext | undefined = getCurrentContext()
): boolean {
  const cached = credentialCache.get(userId);
  if (cached && cached.expiresAt - Date.now() > EXPIRY_MARGIN_MS) return true;
  const idToken = getCallerIdToken(undefined, context);
  return !!idToken && (decodeJwtExpiryMs(idToken) ?? Infinity) > Date.now();
}

/**
 * Get environment variables for a child process that restrict S3 and DynamoDB access


 * to the given user's resources. Used by execute_command to scope `aws s3` and
 * `aws dynamodb` commands run in child processes.
 *
 * @param userId - The authenticated user's ID (Cognito User Pool sub UUID).
 * @returns Environment variable overrides for the child process.
 */
export async function getUserScopedEnvVars(userId: string): Promise<Record<string, string>> {
  const { credentials } = await assumeUserScopedRole(userId);

  return {
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId!,
    AWS_SECRET_ACCESS_KEY: credentials.SecretKey!,
    AWS_SESSION_TOKEN: credentials.SessionToken!,
    AWS_REGION: config.AWS_REGION,
  };
}

/**
 * Get the Identity Pool identityId for the given user.
 * Calls GetId if not already cached in the request context.
 *
 * @param userId - The authenticated user's ID (Cognito User Pool sub UUID).
 * @returns The Identity Pool identityId (format: "REGION:uuid").
 */
export async function getIdentityId(userId: string): Promise<IdentityId> {
  // Check context cache first
  const context = getCurrentContext();
  if (context?.identityId) {
    return context.identityId;
  }
  // Trigger credential exchange which populates identityId in context
  const { identityId } = await assumeUserScopedRole(userId);
  return identityId;
}
