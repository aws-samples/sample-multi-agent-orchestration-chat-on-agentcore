import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { fileURLToPath } from 'node:url';

// Static build of the mock only — dev-server module-per-request traffic gets
// rate limited when tunnelled (lll expose), a bundled build does not.
// Usage (in packages/frontend): npx vite build -c src/mocks/tool-steps/vite.config.ts && npx vite preview -c src/mocks/tool-steps/vite.config.ts
const root = fileURLToPath(new URL('../../..', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: 'dist/tool-steps-mock',
    rollupOptions: { input: `${root}/tool-steps-mock.html` },
  },
  preview: { port: 5173, host: '127.0.0.1', allowedHosts: ['.on.aws'] },
});
