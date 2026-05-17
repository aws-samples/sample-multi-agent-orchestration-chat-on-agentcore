/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: true }] },
  testMatch: ['**/tests/developer-auth-identity.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 60000,
  globalSetup: './jest.integration.setup.js',
};
