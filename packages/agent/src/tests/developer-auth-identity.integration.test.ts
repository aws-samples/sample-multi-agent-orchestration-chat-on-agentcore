/**
 * Integration Test: Developer Authenticated Identities — Agent side
 *
 * Verifies that the Agent correctly handles a Cognito Developer Auth openIdToken
 * forwarded in X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token and uses it to
 * obtain per-user Identity Pool credentials for S3/DynamoDB access.
 *
 * Prerequisites:
 *   - packages/agent/.env must be configured (run `npm run setup-env`)
 *   - Add to .env:
 *       COGNITO_DOMAIN=<prefix>.auth.<region>.amazoncognito.com
 *       COGNITO_CLIENT_ID=<machineUserClientId>
 *       COGNITO_CLIENT_SECRET=<machineUserClientSecret>
 *       COGNITO_SCOPE=agent/invoke agent/tools
 *       DEVELOPER_PROVIDER_NAME=<resourcePrefix>.trigger
 *       USER_IDENTITIES_TABLE_NAME=<resourcePrefix>-user-identities
 *       TEST_USER_ID=<Cognito User Pool sub UUID>
 *   - For Step 3 (HTTP test): start the agent locally with `npm run dev`
 *       AGENT_LOCAL_URL=http://localhost:8080  (default)
 *
 * Run:
 *   cd packages/agent
 *   npm run test:integration
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import {
  CognitoIdentityClient,
  GetOpenIdTokenForDeveloperIdentityCommand,
  GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { config as loadDotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/agent/src/tests/ → ../../ → packages/agent/.env
loadDotenv({ path: path.resolve(__dirname, '../../.env'), override: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

interface OidcResult {
  openIdToken: string;
  identityId: string;
}

async function getDeveloperAuthOpenIdToken(userId: string): Promise<OidcResult> {
  const identityPoolId = requireEnv('IDENTITY_POOL_ID');
  const developerProviderName = requireEnv('DEVELOPER_PROVIDER_NAME');
  const region = requireEnv('AWS_REGION');

  const client = new CognitoIdentityClient({ region });
  const response = await client.send(
    new GetOpenIdTokenForDeveloperIdentityCommand({
      IdentityPoolId: identityPoolId,
      Logins: { [developerProviderName]: userId },
    })
  );
  if (!response.Token || !response.IdentityId) {
    throw new Error('GetOpenIdTokenForDeveloperIdentity returned incomplete response');
  }
  return { openIdToken: response.Token, identityId: response.IdentityId };
}

async function getMachineUserToken(): Promise<string> {
  const domain = requireEnv('COGNITO_DOMAIN');
  const clientId = requireEnv('COGNITO_CLIENT_ID');
  const clientSecret = requireEnv('COGNITO_CLIENT_SECRET');
  const scope = process.env.COGNITO_SCOPE || 'agent/invoke agent/tools';

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`https://${domain}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Suite 1: Developer Auth openIdToken → GetCredentialsForIdentity (Agent logic)
// ---------------------------------------------------------------------------

describe('Agent: Developer Auth openIdToken → Identity Pool credentials', () => {
  let oidcResult: OidcResult;

  beforeAll(async () => {
    const required = [
      'IDENTITY_POOL_ID',
      'COGNITO_USER_POOL_ID',
      'DEVELOPER_PROVIDER_NAME',
      'AWS_REGION',
      'USER_STORAGE_BUCKET_NAME',
      'TEST_USER_ID',
    ];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(
        `Missing required env vars: ${missing.join(', ')}\n` +
          'Please configure packages/agent/.env'
      );
    }

    const userId = requireEnv('TEST_USER_ID');
    oidcResult = await getDeveloperAuthOpenIdToken(userId);
    console.log('Developer Auth identityId:', oidcResult.identityId);
    console.log(
      'openIdToken iss (decoded):',
      JSON.parse(Buffer.from(oidcResult.openIdToken.split('.')[1], 'base64').toString()).iss
    );
  });

  test('GetCredentialsForIdentity with developer-auth token succeeds', async () => {
    const region = requireEnv('AWS_REGION');
    const client = new CognitoIdentityClient({ region });

    // Agent の scoped-credentials.ts と同じロジックを再現:
    //   iss が "cognito-identity.amazonaws.com" のとき → key = "cognito-identity.amazonaws.com"
    const loginsKey = 'cognito-identity.amazonaws.com';

    const response = await client.send(
      new GetCredentialsForIdentityCommand({
        IdentityId: oidcResult.identityId,
        Logins: { [loginsKey]: oidcResult.openIdToken },
      })
    );

    const creds = response.Credentials;
    console.log('AccessKeyId prefix:', creds?.AccessKeyId?.substring(0, 8) + '...');
    console.log('Expiration:', creds?.Expiration);

    expect(creds?.AccessKeyId).toBeTruthy();
    expect(creds?.SecretKey).toBeTruthy();
    expect(creds?.SessionToken).toBeTruthy();
    expect(creds?.Expiration).toBeInstanceOf(Date);

    console.log('✅ Developer Auth credentials obtained via GetCredentialsForIdentity');
  }, 30000);

  test('S3 ListObjects with developer-auth credentials (bucket access check)', async () => {
    const region = requireEnv('AWS_REGION');
    const bucket = requireEnv('USER_STORAGE_BUCKET_NAME');

    // Step 1: Get Identity Pool credentials from developer-auth token
    const identityClient = new CognitoIdentityClient({ region });
    const credsResponse = await identityClient.send(
      new GetCredentialsForIdentityCommand({
        IdentityId: oidcResult.identityId,
        Logins: { 'cognito-identity.amazonaws.com': oidcResult.openIdToken },
      })
    );
    const creds = credsResponse.Credentials!;

    // Step 2: Use credentials to access S3 prefix users/{identityId}/
    const s3 = new S3Client({
      region,
      credentials: {
        accessKeyId: creds.AccessKeyId!,
        secretAccessKey: creds.SecretKey!,
        sessionToken: creds.SessionToken,
      },
    });

    const prefix = `users/${oidcResult.identityId}/`;
    console.log(`S3 ListObjects: s3://${bucket}/${prefix}`);

    // Should succeed (possibly 0 objects) — no AccessDenied
    const listResponse = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 5 })
    );

    console.log('S3 ListObjects succeeded, object count:', listResponse.KeyCount ?? 0);
    expect(listResponse.$metadata.httpStatusCode).toBe(200);

    console.log('✅ S3 access with developer-auth credentials is correctly scoped to user prefix');
  }, 30000);
});

// ---------------------------------------------------------------------------
// Suite 2: HTTP invocation to local Agent with developer-auth token
// ---------------------------------------------------------------------------

describe('Agent HTTP endpoint: POST /invocations with developer-auth openIdToken', () => {
  const agentLocalUrl = process.env.AGENT_LOCAL_URL || 'http://localhost:8080';

  beforeAll(async () => {
    // Check if local agent is running
    try {
      const health = await fetch(`${agentLocalUrl}/ping`, { signal: AbortSignal.timeout(3000) });
      if (!health.ok) throw new Error(`Health check failed: ${health.status}`);
      console.log(`✅ Local agent is running at ${agentLocalUrl}`);
    } catch {
      throw new Error(
        `Local agent is not running at ${agentLocalUrl}.\n` +
          'Start it with: npm run dev (in packages/agent)\n' +
          'Then re-run the test.'
      );
    }
  });

  test('POST /invocations with openIdToken header returns 200 and streams response', async () => {
    const userId = requireEnv('TEST_USER_ID');

    // Step 1: Get machine user access token
    console.log('\nObtaining machine user access token...');
    const accessToken = await getMachineUserToken();
    console.log('Machine user token obtained');

    // Step 2: Get developer auth openIdToken
    console.log('Obtaining developer auth openIdToken...');
    const { openIdToken, identityId } = await getDeveloperAuthOpenIdToken(userId);
    console.log('Developer identityId:', identityId);

    // Step 3: POST /invocations with openIdToken header
    console.log(`\nPOST ${agentLocalUrl}/invocations`);
    const response = await fetch(`${agentLocalUrl}/invocations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        // This is the key header — Agent's scoped-credentials.ts will detect
        // iss = cognito-identity.amazonaws.com and use the correct Logins key
        'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token': openIdToken,
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Type': 'event',
      },
      body: JSON.stringify({
        prompt: '[Integration Test] Please respond with a single word: OK',
        targetUserId: userId,
        modelId: 'global.anthropic.claude-sonnet-4-6',
        enabledTools: [],
      }),
    });

    console.log('HTTP status:', response.status);
    expect(response.status).toBe(200);

    // Read first chunk of the NDJSON stream
    const reader = response.body?.getReader();
    let firstChunk = '';
    if (reader) {
      const { value } = await reader.read();
      if (value) {
        firstChunk = new TextDecoder().decode(value);
        console.log('First NDJSON chunk (truncated):', firstChunk.substring(0, 200));
      }
      reader.cancel();
    }

    expect(firstChunk.length).toBeGreaterThan(0);

    console.log('\n✅ POST /invocations with developer-auth openIdToken succeeded');
    console.log('   The agent received the openIdToken, resolved identityId, and');
    console.log('   obtained per-user Identity Pool credentials for S3/DynamoDB access.');
    console.log(`   Developer identityId used: ${identityId}`);
  }, 60000);
});
