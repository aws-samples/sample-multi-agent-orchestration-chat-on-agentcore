import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Live integration tests run via vitest.integration.config.ts (opt-in,
    // they hit real Bedrock). Keep them out of the default unit-test run.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
      // Coverage floor (ratchet): raise these when coverage improves, never lower them.
      thresholds: { statements: 89, branches: 91, functions: 91, lines: 88 },
    },
  },
});
