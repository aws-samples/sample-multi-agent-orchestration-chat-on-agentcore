/**
 * Jest configuration for integration tests.
 *
 * Unlike the default jest.config.ts, this config:
 * - Includes integration.test.ts (removed from testPathIgnorePatterns)
 * - Runs only integration tests (testPathPattern restricts to integration files)
 */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  testMatch: ['**/__tests__/integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 60000, // 60 seconds for integration tests that call real AWS
};
