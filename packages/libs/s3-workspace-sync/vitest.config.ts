import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Coverage floor (ratchet): raise these when coverage improves, never lower them.
      thresholds: { statements: 83, branches: 75, functions: 83, lines: 84 },
    },
  },
});
