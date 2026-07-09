import base from '../../jest.config.base.js';

// Integration config: runs ONLY *.integration.test.ts, which hit the real
// OpenAI Images API using OPENAI_API_KEY loaded from the co-located .env by
// jest.integration.setup.cjs. Kept separate from the default unit run so CI
// (which has no key) stays green via the `describe.skip` guard in the suite.
export default {
  ...base,
  testMatch: ['**/*.integration.test.ts'],
  testPathIgnorePatterns: (base.testPathIgnorePatterns ?? []).filter(
    (p) => p !== '\\.integration\\.test\\.ts$'
  ),
  setupFiles: ['<rootDir>/jest.integration.setup.cjs'],
  // OpenAI image generation can take well over the base 30s; give it room.
  testTimeout: 120000,
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '^@moca/lambda-tools-shared$': '<rootDir>/../../shared/src/index.ts',
  },
};
