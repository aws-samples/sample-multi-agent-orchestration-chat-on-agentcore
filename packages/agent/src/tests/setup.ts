/**
 * Jest test setup file
 */

import { jest } from '@jest/globals';
import { config } from 'dotenv';
import path from 'path';

// Load environment variables for testing
config({ path: path.resolve('.env') });

// Set default environment variables for testing (CI environment support).
// Tests that import the real config module (not a jest mock) need every
// required var present, otherwise parseEnv() throws at import time and the
// whole suite fails to run in CI where no .env exists.
if (!process.env.AGENTCORE_GATEWAY_ENDPOINT) {
  process.env.AGENTCORE_GATEWAY_ENDPOINT = 'https://test.example.com';
}
process.env.IDENTITY_POOL_ID ??= 'test-identity-pool';
process.env.COGNITO_USER_POOL_ID ??= 'test-user-pool';
process.env.COGNITO_USER_POOL_CLIENT_ID ??= 'test-client';
process.env.BACKEND_API_URL ??= 'https://test.example.com';

// Set test timeout to 30 seconds
jest.setTimeout(30000);
