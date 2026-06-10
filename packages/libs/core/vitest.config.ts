import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Live integration tests run via vitest.integration.config.ts (opt-in,
    // they hit real Bedrock). Keep them out of the default unit-test run.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
});
