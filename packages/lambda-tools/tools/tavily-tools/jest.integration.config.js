import base from '../../jest.config.base.js';

/**
 * Integration test config for @moca/lambda-tools-tavily.
 *
 * Runs ONLY `*.integration.test.ts` (the unit run in jest.config.js excludes
 * them). These hit the real Tavily API and require TAVILY_API_KEY; the suite
 * self-skips via `describe.skip` when the key is absent, so this config stays
 * green on machines without the secret. `jest.integration.setup.cjs` loads the
 * co-located .env so TAVILY_API_KEY is available without manual sourcing.
 */
export default {
  ...base,
  // Override the base unit pattern: collect integration suites only.
  testMatch: ['**/*.integration.test.ts'],
  // Load .env (TAVILY_API_KEY) before the test files are imported.
  setupFiles: ['<rootDir>/jest.integration.setup.cjs'],
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '^@moca/lambda-tools-shared$': '<rootDir>/../../shared/src/index.ts',
  },
};
