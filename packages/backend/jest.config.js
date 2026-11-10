/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.test\\.ts$'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        isolatedModules: true,
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          esModuleInterop: true,
          composite: false,
          incremental: false,
          declaration: false,
          declarationMap: false,
          noEmit: false,
        },
      },
    ],
  },
  moduleNameMapper: {
    // Resolve @moca/* workspace packages to their TS source so jest can
    // load their runtime values (parseUserId, isAgentId, …). Without this, the
    // packages' `exports` maps are not understood by jest-resolve.
    '^@moca/core$': '<rootDir>/../libs/core/src/index.ts',
    '^@moca/tool-definitions$': '<rootDir>/../libs/tool-definitions/src/index.ts',
    '^@moca/generative-ui-catalog$': '<rootDir>/../libs/generative-ui-catalog/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  setupFilesAfterEnv: ['<rootDir>/src/tests/setup.ts'],
  testTimeout: 30000,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.integration.test.ts',
    '!src/tests/**',
  ],
};
