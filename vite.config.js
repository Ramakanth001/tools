const path = require('node:path');
const { createRequire } = require('node:module');

const toolRequire = createRequire(path.resolve(__dirname, 'pg-backup/package.json'));
const { defineConfig } = toolRequire('vite');
const react = toolRequire('@vitejs/plugin-react');

module.exports = defineConfig({
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
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
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
