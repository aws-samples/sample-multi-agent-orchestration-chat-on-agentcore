/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
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
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testTimeout: 30000,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/__tests__/**'],
  // Coverage floor (ratchet): raise these when coverage improves, never lower them.
  coverageThreshold: { global: { statements: 98, branches: 98, functions: 98, lines: 98 } },
};
