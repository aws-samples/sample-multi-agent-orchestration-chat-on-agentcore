/** DynamoDB Local tests (Docker): npm run test:ddb */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // @moca/core's package exports declare only the `import`/`types` conditions,
    // which ts-jest's resolver can't follow. Map to the TS source (not the ESM
    // dist) so ts-jest transforms it — mirrors packages/backend/jest config.
    '^@moca/core$': '<rootDir>/../libs/core/src/index.ts',
    '^@moca/tool-definitions$': '<rootDir>/../libs/tool-definitions/src/index.ts',
    '^@moca/generative-ui-catalog$': '<rootDir>/../libs/generative-ui-catalog/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        isolatedModules: true,
        tsconfig: {
          composite: false,
          incremental: false,
          declaration: false,
          declarationMap: false,
          noEmit: false,
        },
      },
    ],
  },
  testMatch: ['**/__tests__/*.ddb.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  globalSetup: '<rootDir>/src/tests/ddb-global-setup.ts',
  globalTeardown: '<rootDir>/src/tests/ddb-global-teardown.ts',
  testTimeout: 60000,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/__tests__/**'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
};
