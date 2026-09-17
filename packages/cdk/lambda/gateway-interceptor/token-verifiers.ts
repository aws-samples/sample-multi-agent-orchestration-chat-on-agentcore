import { CognitoJwtVerifier, JwtVerifier } from 'aws-jwt-verify';
import type { JwtPayload } from 'aws-jwt-verify/jwt-model';

export const IDENTITY_ID_PATTERN =
  /^[a-z]{2}-(?:(?:gov-)?[a-z]+-\d):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEVELOPER_ISSUER = 'https://cognito-identity.amazonaws.com';

function requireExpiry(payload: JwtPayload): void {
  if (
    typeof payload.exp !== 'number' ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw new Error('A valid token expiration is required');
  }
}

export function createTokenVerifiers() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const frontendClientId = process.env.COGNITO_USER_POOL_CLIENT_ID;
  const machineClientId = process.env.COGNITO_MACHINE_USER_CLIENT_ID;
  const identityPoolId = process.env.IDENTITY_POOL_ID;
  if (!userPoolId || !frontendClientId || !identityPoolId) {
    throw new Error('Gateway identity verification is not configured');
  }

  const access = CognitoJwtVerifier.create({
    userPoolId,
    tokenUse: 'access',
    clientId: [frontendClientId, ...(machineClientId ? [machineClientId] : [])],
    customJwtCheck: ({ payload }) => requireExpiry(payload),
  });
  const userId = CognitoJwtVerifier.create({
    userPoolId,
    tokenUse: 'id',
    clientId: frontendClientId,
    customJwtCheck: ({ payload }) => requireExpiry(payload),
  });
  const developer = JwtVerifier.create({
    issuer: DEVELOPER_ISSUER,
    audience: identityPoolId,
    jwksUri: `${DEVELOPER_ISSUER}/.well-known/jwks_uri`,
    customJwtCheck: ({ header, payload }) => {
      requireExpiry(payload);
      if (
        header.alg !== 'RS512' ||
        payload.aud !== identityPoolId ||
        typeof payload.sub !== 'string' ||
        !IDENTITY_ID_PATTERN.test(payload.sub)
      ) {
        throw new Error('Invalid delegated identity token');
      }
    },
  });

  return { access, userId, developer, machineClientId };
}

let verifiers: ReturnType<typeof createTokenVerifiers> | undefined;

export async function verifyRequestTokens(accessToken: string, idToken: string) {
  verifiers ??= createTokenVerifiers();
  const access = await verifiers.access.verify(accessToken);
  const isMachine =
    !!verifiers.machineClientId &&
    access.client_id === verifiers.machineClientId &&
    !access.username &&
    !access['cognito:username'] &&
    (!access.sub || access.sub === access.client_id);

  if (isMachine) {
    if (!access.scope?.split(/\s+/).includes('agent/tools')) {
      throw new Error('Gateway tools scope is required');
    }
    const identity = await verifiers.developer.verify(idToken);
    return {
      kind: 'developer' as const,
      userId: access.client_id,
      identityId: identity.sub as string,
      expiresAt: identity.exp as number,
    };
  }

  const identity = await verifiers.userId.verify(idToken);
  if (!access.sub || !identity.sub || access.sub !== identity.sub) {
    throw new Error('Token subjects do not match');
  }
  return {
    kind: 'userPool' as const,
    userId: identity.sub,
    expiresAt: identity.exp as number,
  };
}
