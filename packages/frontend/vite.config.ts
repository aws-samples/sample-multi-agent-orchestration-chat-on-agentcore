import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Moca Chat',
        short_name: 'Moca',
        description: 'AI Chat Application powered by AgentCore',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        orientation: 'portrait-primary',
        icons: [
          {
            src: '/icons/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gstatic-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
  define: {
    global: 'globalThis', // Map Node.js global to globalThis
  },
  server: {
    proxy: {
      '/invocations': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ping': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Rollup output settings
    rollupOptions: {
      output: {
        // Separate large libraries into separate chunks to improve cache efficiency
        manualChunks: {
          // React related (core libraries)
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],

          // Markdown rendering related (relatively large)
          'vendor-markdown': [
            'react-markdown',
            'remark-gfm',
            'remark-math',
            'rehype-katex',
            'katex',
          ],

          // Mermaid diagrams (very large)
          'vendor-mermaid': ['mermaid'],

          // Syntax highlighting (large)
          'vendor-syntax': ['react-syntax-highlighter'],

          // Authentication related
          'vendor-auth': ['aws-amplify'],

          // State management and utilities
          'vendor-utils': ['zustand', 'zod', 'uuid'],
        },
      },
    },

    // Chunk size warning threshold (500KB)
    chunkSizeWarningLimit: 500,

    // Disable source maps in production (reduce size)
    sourcemap: false,

    // CSS code splitting
    cssCodeSplit: true,

    // Minification settings
    minify: 'esbuild',

    // Set target to modern browsers for smaller bundle
    target: 'es2020',
  },
});
