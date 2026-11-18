import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**', 'src/**/*.d.ts'],
      // Coverage floor (ratchet): raise these when coverage improves, never lower them.
      thresholds: { statements: 49, branches: 43, functions: 48, lines: 48 },
    },
    environmentOptions: {
      jsdom: {
        resources: 'usable',
      },
    },
  },
});
