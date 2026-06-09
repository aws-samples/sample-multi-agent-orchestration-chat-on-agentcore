/**
 * Jest config for Repository integration tests.
 *
 * Only `*.integration.test.ts` files are picked up. `globalSetup` waits
 * for DynamoDB Local (either the developer's docker-compose service or
 * the CI service container) to become reachable and provisions the
 * Triggers / Sessions tables with the CDK-matching key schema.
 *
 * Every test run spins up a fresh randomly-named table, so tests are
 * isolated from each other and from any prior state.
 */

/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // Scope: only Repository-layer integration tests run against DDB
  // Local. The legacy `services/__tests__/agents-service.integration.test.ts`
  // is intentionally excluded — it predates this harness, requires
  // real AWS credentials + SSM, and still self-gates via env vars.
  testMatch: ['<rootDir>/src/repositories/**/*.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
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
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // `uuid` is pure ESM (exports via `exports` map with no CJS
    // variant), so ts-jest's CommonJS transform can't `require` it.
    // Integration tests only need *some* unique id, not specifically
    // UUIDv7 — swap in a tiny CJS shim backed by `crypto.randomUUID()`.
    // Unit tests that DO care about the id format already mock `uuid`
    // directly via `jest.mock`, so this mapping doesn't affect them.
    '^uuid$': '<rootDir>/src/tests/integration/uuid-shim.cjs',
  },
  globalSetup: '<rootDir>/src/tests/integration/global-setup.ts',
  globalTeardown: '<rootDir>/src/tests/integration/global-teardown.ts',
  testTimeout: 60000,
  // Emit into a separate directory so integration coverage does not clobber
  // the unit-test `coverage/`; the root merge step picks up both and combines
  // per-file hit counts across the two runs.
  coverageProvider: 'v8',
  coverageDirectory: 'coverage-integration',
  coverageReporters: ['json', 'text-summary'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.integration.test.ts',
    '!src/tests/**',
  ],
};
