/**
 * Integration Tests for Trigger Lambda — Developer Authenticated Identities
 *
 * These tests connect to real AWS resources and verify the full event-driven
 * invocation flow using GetOpenIdTokenForDeveloperIdentity.
 *
 * Prerequisites:
 * - Run `npm run setup-env` (or `npm run devw`) to generate packages/trigger/.env
 * - Manually uncomment and set TEST_USER_ID / TEST_AGENT_ID / TEST_TRIGGER_ID
 *   in packages/trigger/.env
 * - AWS credentials must be available (AWS_PROFILE or environment variables)
 *
 * Run:
 *   cd packages/trigger
 *   npm run test:integration
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import {
  CognitoIdentityClient,
  GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import { config } from 'dotenv';
import { AuthService } from '../services/auth-service.js';
import { handler } from '../index.js';

// Load environment variables from .env file (override existing)
config({ override: true });

// Force AWS_REGION to match .env file
if (process.env.AWS_REGION) {
  process.env.AWS_DEFAULT_REGION = process.env.AWS_REGION;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const base64 = token.split('.')[1];
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
}

// ---------------------------------------------------------------------------
// Test Suite 1: getOpenIdTokenForUser() — Developer Auth token issuance
// ---------------------------------------------------------------------------

describe('AuthService.getOpenIdTokenForUser() — Developer Authenticated Identities', () => {
  let authService: AuthService;

  beforeAll(() => {
    const required = [
      'COGNITO_DOMAIN',
      'COGNITO_CLIENT_ID',
      'COGNITO_CLIENT_SECRET',
      'IDENTITY_POOL_ID',
      'DEVELOPER_PROVIDER_NAME',
      'AWS_REGION',
    ];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(', ')}\n` +
          'Please run npm run setup-env and configure .env'
      );
    }

    authService = AuthService.fromEnvironment();
    console.log('AuthService initialized');
    console.log('  IDENTITY_POOL_ID:', process.env.IDENTITY_POOL_ID);
    console.log('  DEVELOPER_PROVIDER_NAME:', process.env.DEVELOPER_PROVIDER_NAME);
    console.log('  AWS_REGION:', process.env.AWS_REGION);
  });

  test('returns openIdToken and identityId for a valid userId', async () => {
    const userId = requireEnv('TEST_USER_ID');

    console.log('\n=== Test: getOpenIdTokenForUser() ===');
    console.log('userId:', userId);

    const result = await authService.getOpenIdTokenForUser(userId);

    console.log('identityId:', result.identityId);
    console.log('openIdToken (first 60 chars):', result.openIdToken.substring(0, 60) + '...');

    // identityId must be in REGION:UUID format
    expect(result.identityId).toMatch(/^[a-z0-9-]+:[0-9a-f-]+$/);
    expect(result.openIdToken).toBeTruthy();
    expect(typeof result.openIdToken).toBe('string');
    expect(result.openIdToken.split('.')).toHaveLength(3); // valid JWT structure

    console.log('✅ openIdToken obtained successfully');
  }, 30000);

  test('openIdToken iss is cognito-identity.amazonaws.com', async () => {
    const userId = requireEnv('TEST_USER_ID');

    const result = await authService.getOpenIdTokenForUser(userId);
    const payload = decodeJwtPayload(result.openIdToken);

    console.log('\n=== Test: JWT iss claim ===');
    console.log('iss:', payload.iss);
    console.log('sub:', payload.sub);

    expect(String(payload.iss)).toContain('cognito-identity.amazonaws.com');

    console.log(
      '✅ iss is cognito-identity.amazonaws.com — correct key will be used in GetCredentialsForIdentity'
    );
  }, 30000);
});

// ---------------------------------------------------------------------------
// Test Suite 2: GetCredentialsForIdentity with the developer-auth openIdToken
// ---------------------------------------------------------------------------

describe('GetCredentialsForIdentity — developer-auth token exchange', () => {
  let authService: AuthService;

  beforeAll(() => {
    const required = [
      'COGNITO_DOMAIN',
      'COGNITO_CLIENT_ID',
      'COGNITO_CLIENT_SECRET',
      'IDENTITY_POOL_ID',
      'DEVELOPER_PROVIDER_NAME',
      'AWS_REGION',
      'TEST_USER_ID',
    ];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`Missing required env vars: ${missing.join(', ')}`);
    }
    authService = AuthService.fromEnvironment();
  });

  test('exchanges developer-auth openIdToken for temporary AWS credentials', async () => {
    const userId = requireEnv('TEST_USER_ID');
    const region = requireEnv('AWS_REGION');

    console.log('\n=== Test: GetCredentialsForIdentity ===');

    // Step 1: Obtain openIdToken via Developer Authenticated Identities
    const { openIdToken, identityId } = await authService.getOpenIdTokenForUser(userId);
    console.log('Developer identityId:', identityId);

    // Step 2: Exchange for temporary credentials using the correct Logins key.
    // Developer-auth tokens use "cognito-identity.amazonaws.com" as the key,
    // NOT "cognito-idp.REGION.amazonaws.com/POOL_ID" (which is for UserPool tokens).
    const identityClient = new CognitoIdentityClient({ region });
    const credsResponse = await identityClient.send(
      new GetCredentialsForIdentityCommand({
        IdentityId: identityId,
        Logins: { 'cognito-identity.amazonaws.com': openIdToken },
      })
    );

    const creds = credsResponse.Credentials;
    console.log('AccessKeyId:', creds?.AccessKeyId?.substring(0, 8) + '...');
    console.log('Expiration:', creds?.Expiration);

    expect(creds).toBeDefined();
    expect(creds?.AccessKeyId).toBeTruthy();
    expect(creds?.SecretKey).toBeTruthy();
    expect(creds?.SessionToken).toBeTruthy();
    expect(creds?.Expiration).toBeInstanceOf(Date);

    console.log('✅ Temporary credentials obtained successfully');
    console.log(
      '   The AgentCore Runtime will use these scoped credentials for S3/DynamoDB access'
    );
  }, 30000);
});

// ---------------------------------------------------------------------------
// Test Suite 3: End-to-end handler invocation with Developer Auth
// ---------------------------------------------------------------------------

describe('handler() end-to-end — event-driven invocation with per-user credentials', () => {
  beforeAll(() => {
    const required = [
      'COGNITO_DOMAIN',
      'COGNITO_CLIENT_ID',
      'COGNITO_CLIENT_SECRET',
      'AGENT_API_URL',
      'TRIGGERS_TABLE_NAME',
      'AGENTS_TABLE_NAME',
      'IDENTITY_POOL_ID',
      'DEVELOPER_PROVIDER_NAME',
      'AWS_REGION',
      'TEST_USER_ID',
      'TEST_AGENT_ID',
      'TEST_TRIGGER_ID',
    ];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(', ')}\n` +
          'Please set TEST_USER_ID / TEST_AGENT_ID / TEST_TRIGGER_ID in packages/trigger/.env'
      );
    }

    // Validate TEST_TRIGGER_ID is a valid UUID (required by parseTriggerId)
    const rawTriggerId = process.env.TEST_TRIGGER_ID || '';
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(rawTriggerId)) {
      throw new Error(
        `TEST_TRIGGER_ID="${rawTriggerId}" is not a valid UUID.\n` +
          'Use a real triggerId (UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) from your DynamoDB triggers table.\n' +
          'Example: 019d8953-e65f-747f-8f78-6151ecf3bdfc'
      );
    }

    console.log('Environment loaded:');
    console.log('  AGENT_API_URL:', process.env.AGENT_API_URL);
    console.log('  IDENTITY_POOL_ID:', process.env.IDENTITY_POOL_ID);
    console.log('  DEVELOPER_PROVIDER_NAME:', process.env.DEVELOPER_PROVIDER_NAME);
    console.log('  TEST_USER_ID:', process.env.TEST_USER_ID);
    console.log('  TEST_AGENT_ID:', process.env.TEST_AGENT_ID);
    console.log('  TEST_TRIGGER_ID:', process.env.TEST_TRIGGER_ID);
  });

  test('handler accepts invocation and returns success with hasOpenIdToken=true', async () => {
    const userId = requireEnv('TEST_USER_ID');
    const agentId = requireEnv('TEST_AGENT_ID');
    const triggerId = requireEnv('TEST_TRIGGER_ID');
    const region = requireEnv('AWS_REGION');

    const event = {
      version: '0',
      id: `trigger-${triggerId}`,
      'detail-type': 'Scheduled Event',
      source: 'agentcore.trigger',
      account: '000000000000',
      time: new Date().toISOString(),
      region,
      resources: [],
      detail: {
        triggerId,
        userId,
        agentId,
        prompt: '[Integration Test] Hello from developer auth integration test.',
        modelId: 'global.anthropic.claude-sonnet-4-6',
        workingDirectory: '/',
      },
    };

    console.log('\n=== Test: handler() end-to-end ===');
    console.log('Event:', JSON.stringify(event, null, 2));

    const response = await handler(event);

    console.log('\n=== Handler Response ===');
    console.log(JSON.stringify(response, null, 2));

    expect(response).toBeDefined();
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    console.log('\n=== Response Body ===');
    console.log(JSON.stringify(body, null, 2));

    expect(body.success).toBe(true);
    expect(body.triggerId).toBe(triggerId);
    expect(body.executionId).toBeDefined();

    console.log('\n✅ Handler invocation succeeded');
    console.log('  executionId:', body.executionId);
    console.log('  sessionId:', body.sessionId);
    console.log('  Note: AgentCore Runtime is processing the request asynchronously.');
    console.log('        Check CloudWatch logs for Runtime execution details.');
  }, 60000);
});
