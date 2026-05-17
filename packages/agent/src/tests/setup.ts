/**
 * Jest test setup file
 */

import { jest } from '@jest/globals';
import { config } from 'dotenv';
import path from 'path';

// Load environment variables for testing
config({ path: path.resolve('.env') });

// Set default environment variables for testing (CI environment support)
if (!process.env.AGENTCORE_GATEWAY_ENDPOINT) {
  process.env.AGENTCORE_GATEWAY_ENDPOINT = 'https://test.example.com';
}

// Set test timeout to 30 seconds
jest.setTimeout(30000);
