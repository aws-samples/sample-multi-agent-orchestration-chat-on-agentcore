/**
 * Jest test setup file
 */

import { jest } from '@jest/globals';
import { config } from 'dotenv';
import path from 'path';

// Load environment variables for testing
config({ path: path.resolve('.env') });

// Provide dummy defaults for the config schema's REQUIRED env vars so that any
// test importing the `config` singleton (which runs parseEnv() at import time)
// works in CI, where no .env is present. Real values from .env (loaded above)
// take precedence locally because each assignment is guarded by `if (!set)`.
const TEST_ENV_DEFAULTS: Record<string, string> = {
  AGENTCORE_GATEWAY_ENDPOINT: 'https://test.example.com',
  IDENTITY_POOL_ID: 'ap-northeast-1:00000000-0000-0000-0000-000000000000',
  COGNITO_USER_POOL_ID: 'ap-northeast-1_testpool',
  COGNITO_USER_POOL_CLIENT_ID: 'test-user-pool-client-id',
  BACKEND_API_URL: 'https://backend.test.example.com',
};
for (const [key, value] of Object.entries(TEST_ENV_DEFAULTS)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

// Set test timeout to 30 seconds
jest.setTimeout(30000);
