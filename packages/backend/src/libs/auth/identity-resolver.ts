/**
 * Cognito Identity Pool Identity Resolver
 *
 * Converts a Cognito ID Token into the Identity Pool identityId (format
 * "REGION:uuid"). The identityId is the canonical key for per-user storage
 * (S3 prefix, DynamoDB partition key, AgentCore Memory actorId) because it
 * matches the IAM policy variable `${cognito-identity.amazonaws.com:sub}`
 * used in the Authenticated Role.
 *
 * Called by `authMiddleware` on every request that forwards the ID Token
 * header; the result is cached in-memory keyed by the raw token string.
 *
 * Token type branching
 * --------------------
 * The backend is invoked from TWO different flows that use different ID
 * Token types:
 *
 *   1. Frontend-originated requests
 *      - Token: Cognito UserPool ID Token
 *      - iss:   `https://cognito-idp.{region}.amazonaws.com/{poolId}`
 *      - sub:   UserPool sub UUID (NOT the identityId)
 *      - Flow:  call `GetId` to resolve identityId.
 *
 *   2. Event-driven requests relayed through the Agent
 *      - Token: developer-authenticated OpenID Token issued by Trigger Lambda
 *               via `GetOpenIdTokenForDeveloperIdentity`.
 *      - iss:   `https://cognito-identity.amazonaws.com`
 *      - sub:   the identityId itself (format `REGION:UUID`).
 *      - Flow:  use `sub` directly; `GetId` MUST NOT be called because it
 *               rejects developer-auth tokens with
 *               `NotAuthorizedException: Invalid login token. Can't pass in a Cognito token.`
 *
 * See `docs/adr/event-driven-identity-pool-credentials.md` for the end-to-end
 * design. The Agent container performs the same token-type branching in
 * `packages/agent/src/libs/utils/scoped-credentials.ts` (without the link
 * step — see "Developer login link establishment" below).
 *
 * Developer login link establishment (Backend is the sole owner)
 * --------------------------------------------------------------
 * On the UserPool branch we additionally call
 * `GetOpenIdTokenForDeveloperIdentity(IdentityId=A, Logins={userPool, moca.trigger:userId})`
 * as a fire-and-forget side effect. This permanently links the developer
 * login `{ DEVELOPER_PROVIDER_NAME: userPoolSub }` to the user's Identity
 * Pool identity A. Without this link, Trigger Lambda's subsequent
 * `GetOpenIdTokenForDeveloperIdentity({ moca.trigger: userId })` call (with
 * no IdentityId) would create a brand-new Developer Identity B — causing
 * event-driven invocations to use a different S3 prefix / DynamoDB
 * partition key than the frontend.
 */

import {
  CognitoIdentityClient,
  GetIdCommand,
  GetOpenIdTokenForDeveloperIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import type { IdentityId } from '@moca/core';
import { config } from '../../config/index.js';
import { logger } from '../logger/index.js';

/**
 * Cognito Identity Pool identity ID pattern: "<region>:<uuid>".
 *
 * Duplicated inline (rather than importing `parseIdentityId` from `@moca/core`)
 * so this module has no workspace-package runtime dependency and can be
 * exercised by the existing jest setup (which does not transpile ESM
 * workspace packages). The canonical definition lives in
 * `packages/libs/core/src/identity-id.ts`; both regexes MUST stay in sync.
 */
const IDENTITY_ID_PATTERN =
  /^[a-z]{2}-(?:(?:gov-)?[a-z]+-\d):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertIdentityId(value: string): IdentityId {
  if (!IDENTITY_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid identityId: must match "<region>:<uuid>" format (e.g. "us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"), got "${value}"`
    );
  }
  return value as IdentityId;
}

let identityClient: CognitoIdentityClient | undefined;

function getIdentityClient(): CognitoIdentityClient {
  if (!identityClient) {
    identityClient = new CognitoIdentityClient({ region: config.AWS_REGION });
  }
  return identityClient;
}

/**
 * In-memory cache: idToken → identityId.
 * identityId is stable for the lifetime of the Identity Pool so the cache can
 * be held indefinitely (bounded by the token lifetime).
 */
const identityIdCache = new Map<string, IdentityId>();

/**
 * Tokens for which `linkDeveloperAuthToIdentity` has already been attempted
 * (successfully or not). Prevents spamming `GetOpenIdTokenForDeveloperIdentity`
 * on every request during the lifetime of the Lambda execution environment.
 * The link itself is idempotent at Cognito's side, but this guard keeps the
 * hot path free of unnecessary API calls.
 */
const linkedTokens = new Set<string>();

/**
 * Developer-authenticated OpenID Token issuer.
 * Emitted by `GetOpenIdTokenForDeveloperIdentity`.
 */
const DEVELOPER_AUTH_ISSUER = 'cognito-identity.amazonaws.com';

/**
 * Parsed JWT claims we care about. Only the minimum shape is declared so
 * that invalid tokens are easy to detect without pulling in a full JWT
 * library on the hot path.
 */
interface IdTokenClaims {
  iss?: string;
  sub?: string;
}

/**
 * Decode a JWT payload without verifying the signature. Verification is
 * performed upstream by `aws-jwt-verify` (access token) or — for the
 * developer-auth token — by the downstream Cognito `GetCredentialsForIdentity`
 * call that ultimately consumes the same token elsewhere. Here we only need
 * the `iss` and `sub` claims to branch on token type.
 */
function decodeJwtClaims(idToken: string): IdTokenClaims | undefined {
  const parts = idToken.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64').toString()) as IdTokenClaims;
  } catch {
    return undefined;
  }
}

/**
 * Permanently link the developer login `{ developerProviderName: userPoolSub }`
 * to the Identity Pool identity A (resolved via `GetId`). Fire-and-forget —
 * errors are logged but never propagate to the caller.
 *
 * Idempotent at Cognito's side: subsequent calls with the same IdentityId
 * simply return a new short-lived token for the same identity. We still guard
 * with `linkedTokens` to skip the HTTPS round-trip for tokens already processed
 * in this Lambda execution environment.
 *
 * Security: the target IdentityId A must match the UserPool idToken passed
 * alongside the developer login. Cognito rejects the call with "Logins don't
 * match" otherwise, so this cannot be used to link an arbitrary userId to
 * another user's identity without first possessing a valid UserPool idToken
 * for that identity.
 */
function linkDeveloperAuthToIdentity(params: {
  identityPoolId: string;
  identityId: IdentityId;
  userPoolSub: string;
  idToken: string;
  userPoolLoginsKey: string;
  developerProviderName: string;
}): void {
  if (linkedTokens.has(params.idToken)) return;
  linkedTokens.add(params.idToken);

  void (async () => {
    try {
      await getIdentityClient().send(
        new GetOpenIdTokenForDeveloperIdentityCommand({
          IdentityPoolId: params.identityPoolId,
          IdentityId: params.identityId,
          Logins: {
            // UserPool login proves the caller owns identityId A.
            [params.userPoolLoginsKey]: params.idToken,
            // Developer login permanently linked to identity A on this call.
            [params.developerProviderName]: params.userPoolSub,
          },
        })
      );
      logger.debug(
        { identityId: params.identityId, userPoolSub: params.userPoolSub },
        'Developer login linked to Identity Pool identity'
      );
    } catch (err) {
      // Remove from guard so a later request can retry. The most common
      // failure mode is a transient Cognito error; a permanent
      // misconfiguration (e.g. missing IAM permission) will simply retry
      // on every request, which is acceptable because the link is
      // idempotent and bounded by per-token caching upstream.
      linkedTokens.delete(params.idToken);
      logger.error(
        { err, identityId: params.identityId },
        'linkDeveloperAuthToIdentity failed (non-fatal; event-driven invocations may use a different identityId until link is established)'
      );
    }
  })();
}

/**
 * Resolve the Cognito Identity Pool identityId from a Cognito ID Token
 * (UserPool) or developer-authenticated OpenID Token (event-driven).
 */
export async function resolveIdentityId(idToken: string): Promise<IdentityId> {
  const cached = identityIdCache.get(idToken);
  if (cached) {
    // Cache hit does NOT skip the link attempt: the first request for this
    // token triggered the link; subsequent requests short-circuit via
    // `linkedTokens` inside `linkDeveloperAuthToIdentity`. Re-invoking the
    // function here keeps the logic in one place.
    maybeLinkDeveloperAuth(idToken, cached);
    return cached;
  }

  const claims = decodeJwtClaims(idToken);
  const isDeveloperAuthToken = !!claims?.iss?.includes(DEVELOPER_AUTH_ISSUER);

  // Developer-auth token: `sub` IS the identityId. `GetId` rejects this
  // token type, so skip the API call entirely.
  if (isDeveloperAuthToken) {
    if (!claims?.sub) {
      throw new Error('Developer-auth OpenID Token is missing `sub` claim (identityId)');
    }
    const parsed = assertIdentityId(claims.sub);
    identityIdCache.set(idToken, parsed);
    return parsed;
  }

  // UserPool ID Token: resolve identityId via GetId.
  const loginsKey = `cognito-idp.${config.AWS_REGION}.amazonaws.com/${config.COGNITO_USER_POOL_ID}`;

  const response = await getIdentityClient().send(
    new GetIdCommand({
      IdentityPoolId: config.IDENTITY_POOL_ID,
      Logins: { [loginsKey]: idToken },
    })
  );

  const identityId = response.IdentityId;
  if (!identityId) {
    throw new Error('GetId did not return an IdentityId');
  }

  const parsed = assertIdentityId(identityId);
  identityIdCache.set(idToken, parsed);

  // Establish (or refresh) the developer-auth link on the UserPool branch.
  // This is the ONLY path that runs on every frontend login, so it is the
  // right place to guarantee the link exists before Trigger Lambda ever
  // needs it.
  maybeLinkDeveloperAuth(idToken, parsed, claims?.sub);

  return parsed;
}

/**
 * Wrapper that skips linking when:
 *   - `DEVELOPER_PROVIDER_NAME` env var is not configured (local dev);
 *   - the token is a developer-auth token (no UserPool idToken available —
 *     Cognito would reject the call anyway);
 *   - the UserPool sub is missing (malformed token).
 */
function maybeLinkDeveloperAuth(
  idToken: string,
  identityId: IdentityId,
  userPoolSub?: string
): void {
  const developerProviderName = config.DEVELOPER_PROVIDER_NAME;
  if (!developerProviderName) return;

  // `userPoolSub` is only supplied on the UserPool resolution path. For
  // cache hits we re-parse the token once to fish out the sub; this is cheap
  // (no crypto) and only happens when linking is actually enabled.
  let sub = userPoolSub;
  if (!sub) {
    const claims = decodeJwtClaims(idToken);
    if (!claims || claims.iss?.includes(DEVELOPER_AUTH_ISSUER)) return;
    sub = claims.sub;
  }
  if (!sub) return;

  linkDeveloperAuthToIdentity({
    identityPoolId: config.IDENTITY_POOL_ID,
    identityId,
    userPoolSub: sub,
    idToken,
    userPoolLoginsKey: `cognito-idp.${config.AWS_REGION}.amazonaws.com/${config.COGNITO_USER_POOL_ID}`,
    developerProviderName,
  });
}

/**
 * Test-only: clear the in-memory caches between test cases. Not exported on
 * the production path — imported via the module path in jest.
 */
export function __resetCachesForTests(): void {
  identityIdCache.clear();
  linkedTokens.clear();
}
