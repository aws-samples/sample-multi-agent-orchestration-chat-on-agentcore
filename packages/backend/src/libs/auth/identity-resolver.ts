import { createHash } from 'node:crypto';
import {
  CognitoIdentityClient,
  GetIdCommand,
  GetOpenIdTokenForDeveloperIdentityCommand,
  LookupDeveloperIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import type { IdentityId } from '@moca/core';
import { config } from '../../config/index.js';
import { logger } from '../logger/index.js';
import { verifyDeveloperAuthToken, verifyIdToken } from './jwks.js';

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

const MAX_CACHE_ENTRIES = 1000;
const TARGET_USER_CACHE_TTL_MS = 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const identityIdCache = new Map<string, CacheEntry<IdentityId>>();
const targetUserCache = new Map<string, CacheEntry<IdentityId>>();

function cacheSet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  expiresAt: number
): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt });
}

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * Tokens for which `linkDeveloperAuthToIdentity` has already been attempted
 * (successfully or not). Prevents spamming `GetOpenIdTokenForDeveloperIdentity`
 * on every request during the lifetime of the Lambda execution environment.
 * The link itself is idempotent at Cognito's side, but this guard keeps the
 * hot path free of unnecessary API calls.
 */
const linkedTokens = new Map<string, CacheEntry<true>>();

/**
 * Developer-authenticated OpenID Token issuer.
 * Emitted by `GetOpenIdTokenForDeveloperIdentity`.
 */
const DEVELOPER_AUTH_ISSUER = 'https://cognito-identity.amazonaws.com';

/**
 * Parsed JWT claims we care about. Only the minimum shape is declared so
 * that invalid tokens are easy to detect without pulling in a full JWT
 * library on the hot path.
 */
interface IdTokenClaims {
  iss?: string;
}

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
  expiresAt: number;
}): void {
  const tokenKey = createHash('sha256').update(params.idToken).digest('hex');
  if (cacheGet(linkedTokens, tokenKey)) return;
  cacheSet(linkedTokens, tokenKey, true, params.expiresAt);

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
      linkedTokens.delete(tokenKey);
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
  const claims = decodeJwtClaims(idToken);
  const isDeveloperAuthToken = claims?.iss === DEVELOPER_AUTH_ISSUER;

  if (isDeveloperAuthToken) {
    const verified = await verifyDeveloperAuthToken(idToken);
    if (!verified.valid || !verified.payload?.sub) {
      throw new Error(verified.error || 'Developer-auth OpenID Token verification failed');
    }
    return assertIdentityId(verified.payload.sub);
  }

  const idResult = await verifyIdToken(idToken);
  if (!idResult.valid || !idResult.payload?.sub || !Number.isFinite(idResult.payload.exp)) {
    throw new Error(idResult.error || 'UserPool ID Token verification failed');
  }

  const tokenExp = idResult.payload.exp;
  if (!tokenExp || tokenExp <= Math.floor(Date.now() / 1000)) {
    throw new Error('UserPool ID Token exp must be in the future');
  }
  const tokenExpiresAt = tokenExp * 1000;
  const tokenKey = createHash('sha256').update(idToken).digest('hex');
  const cached = cacheGet(identityIdCache, tokenKey);
  if (cached) {
    maybeLinkDeveloperAuth(idToken, cached, idResult.payload.sub, tokenExpiresAt);
    return cached;
  }

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
  cacheSet(identityIdCache, tokenKey, parsed, tokenExpiresAt);
  maybeLinkDeveloperAuth(idToken, parsed, idResult.payload.sub, tokenExpiresAt);

  return parsed;
}

function maybeLinkDeveloperAuth(
  idToken: string,
  identityId: IdentityId,
  userPoolSub: string,
  expiresAt: number
): void {
  const developerProviderName = config.DEVELOPER_PROVIDER_NAME;
  if (!developerProviderName) return;

  linkDeveloperAuthToIdentity({
    identityPoolId: config.IDENTITY_POOL_ID,
    identityId,
    userPoolSub,
    idToken,
    expiresAt,
    userPoolLoginsKey: `cognito-idp.${config.AWS_REGION}.amazonaws.com/${config.COGNITO_USER_POOL_ID}`,
    developerProviderName,
  });
}

export async function verifyTargetUserLinkedToIdentity(params: {
  targetUserId: string;
  identityId: IdentityId;
}): Promise<void> {
  const developerProviderName = config.DEVELOPER_PROVIDER_NAME;
  if (!developerProviderName) throw new Error('Developer provider is not configured');

  const key = `${config.IDENTITY_POOL_ID}:${params.targetUserId}:${params.identityId}`;
  const cached = cacheGet(targetUserCache, key);
  if (cached === params.identityId) return;

  const response = await getIdentityClient().send(
    new LookupDeveloperIdentityCommand({
      IdentityPoolId: config.IDENTITY_POOL_ID,
      DeveloperUserIdentifier: params.targetUserId,
      MaxResults: 1,
    })
  );

  if (response.IdentityId !== params.identityId) {
    throw new Error('Target user is not linked to the authenticated identity');
  }

  cacheSet(targetUserCache, key, params.identityId, Date.now() + TARGET_USER_CACHE_TTL_MS);
}

export function __resetCachesForTests(): void {
  identityIdCache.clear();
  targetUserCache.clear();
  linkedTokens.clear();
}
