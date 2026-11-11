import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolRequire = createRequire(path.resolve(__dirname, 'pg-backup/package.json'));

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  resolve: {
    alias: [
      { find: /^react$/, replacement: toolRequire.resolve('react') },
      { find: /^react\/jsx-runtime$/, replacement: toolRequire.resolve('react/jsx-runtime') },
      { find: /^react\/jsx-dev-runtime$/, replacement: toolRequire.resolve('react/jsx-dev-runtime') },
      { find: /^react-dom$/, replacement: toolRequire.resolve('react-dom') },
      { find: /^react-dom\/client$/, replacement: toolRequire.resolve('react-dom/client') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    entries: ['src/ui/main.jsx'],
    include: [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    watch: {
      ignored: [
        '**/backups/**',
        '**/.venv/**',
        '**/venv/**',
        '**/node_modules/**',
        '**/.git/**',
        '**/public/**',
        '**/models/**',
        '**/whisper_models/**',
        '**/output/**',
        '**/exports/**',
        '**/*.dump',
        '**/*.sql*',
      ],
    },
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: 'public',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) return 'react';
          if (id.includes('node_modules/reactflow/')) return 'reactflow';
          if (id.includes('node_modules/elkjs/')) return 'elk';
          return undefined;
        },
      },
    },
  },
});
