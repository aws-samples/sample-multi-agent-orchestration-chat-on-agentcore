/**
 * Jest config for repository integration tests that run against DynamoDB Local.
 *
 * Kept separate from `jest.integration.config.js` (which runs the real-AWS
 * credential / model suites) so that:
 *   - DynamoDB Local (Docker) is only started for the tests that need it, and
 *   - the real-AWS suites are never coupled to a Docker daemon.
 *
 * globalSetup starts `amazon/dynamodb-local` via Testcontainers and exposes its
 * endpoint; every run provisions freshly named tables, so suites are isolated.
 */

/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: true }] },
  testMatch: ['**/repositories/**/*.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  globalSetup: '<rootDir>/src/tests/integration/global-setup.ts',
  globalTeardown: '<rootDir>/src/tests/integration/global-teardown.ts',
  testTimeout: 60000,
  // Emit into a separate directory so DDB-Local coverage does not clobber the
  // unit-test `coverage/`; the root merge step picks up both and combines
  // per-file hit counts across the two runs.
  coverageProvider: 'v8',
  coverageDirectory: 'coverage-integration',
  coverageReporters: ['json', 'text-summary'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/tests/**', '!src/index.ts'],
};
