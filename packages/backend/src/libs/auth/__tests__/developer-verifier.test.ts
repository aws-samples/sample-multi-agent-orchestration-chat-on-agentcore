import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync, sign } from 'node:crypto';

const poolId = 'us-east-1:00000000-0000-0000-0000-000000000000';
const issuer = 'https://cognito-identity.amazonaws.com';
const identityId = 'us-east-1:11111111-1111-1111-1111-111111111111';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kty: 'RSA',
  kid: 'dev-key',
  use: 'sig',
  alg: 'RS512',
};
const now = () => Math.floor(Date.now() / 1000);

function token(payload: Record<string, unknown>, algorithm = 'RS512', wrongKey = false) {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, kid: 'dev-key' })).toString(
    'base64url'
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const input = `${header}.${body}`;
  const signature =
    algorithm === 'none'
      ? ''
      : sign(
          algorithm === 'RS512' ? 'RSA-SHA512' : 'RSA-SHA256',
          Buffer.from(input),
          wrongKey ? otherKeys.privateKey : keys.privateKey
        ).toString('base64url');
  return `${input}.${signature}`;
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.resetModules();
  Object.assign(process.env, {
    AWS_REGION: 'us-east-1',
    NODE_ENV: 'test',
    COGNITO_REGION: 'us-east-1',
    AGENTCORE_MEMORY_ID: 'memory-id',
    AGENTCORE_SEMANTIC_STRATEGY_ID: 'strategy-id',
    AGENTCORE_GATEWAY_ENDPOINT: 'https://gateway.example',
    USER_STORAGE_BUCKET_NAME: 'bucket',
    AGENTS_TABLE_NAME: 'agents',
    SESSIONS_TABLE_NAME: 'sessions',
    SSM_PARAMETER_PREFIX: '/moca/test',
    TRIGGERS_TABLE_NAME: 'triggers',
    TRIGGER_LAMBDA_ARN: 'arn:aws:lambda:us-east-1:123456789012:function:trigger',
    SCHEDULER_ROLE_ARN: 'arn:aws:iam::123456789012:role/scheduler',
    IDENTITY_POOL_ID: poolId,
    COGNITO_USER_POOL_ID: 'us-east-1_testpool',
    COGNITO_USER_POOL_CLIENT_ID: 'frontend-client',
  });
});

describe('createDeveloperAuthVerifier', () => {
  it('accepts a real RS512 Cognito Identity developer token', async () => {
    const { createDeveloperAuthVerifier } = await import('../jwks.js');
    const verifier = createDeveloperAuthVerifier(poolId);
    verifier.cacheJwks({ keys: [jwk] }, issuer);
    await expect(
      verifier.verify(token({ iss: issuer, aud: poolId, sub: identityId, exp: now() + 600 }))
    ).resolves.toEqual(expect.objectContaining({ sub: identityId }));
  });

  it.each([
    [
      'bad signature',
      token({ iss: issuer, aud: poolId, sub: identityId, exp: now() + 600 }, 'RS512', true),
    ],
    ['none alg', token({ iss: issuer, aud: poolId, sub: identityId, exp: now() + 600 }, 'none')],
    ['RS256 alg', token({ iss: issuer, aud: poolId, sub: identityId, exp: now() + 600 }, 'RS256')],
    [
      'wrong issuer',
      token({ iss: `${issuer}.invalid`, aud: poolId, sub: identityId, exp: now() + 600 }),
    ],
    ['wrong audience', token({ iss: issuer, aud: 'wrong', sub: identityId, exp: now() + 600 })],
    ['missing exp', token({ iss: issuer, aud: poolId, sub: identityId })],
    ['expired', token({ iss: issuer, aud: poolId, sub: identityId, exp: now() - 1 })],
    ['invalid sub', token({ iss: issuer, aud: poolId, sub: 'user-sub', exp: now() + 600 })],
  ])('rejects %s', async (_name, jwt) => {
    const { createDeveloperAuthVerifier } = await import('../jwks.js');
    const verifier = createDeveloperAuthVerifier(poolId);
    verifier.cacheJwks({ keys: [jwk] }, issuer);
    await expect(verifier.verify(jwt)).rejects.toThrow();
  });
});
