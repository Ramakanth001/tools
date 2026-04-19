const path = require('node:path');
const { requireToolDep } = require('./requireToolDep');

const { defineConfig } = requireToolDep('vite');
const react = requireToolDep('@vitejs/plugin-react');

const SHARED_NODE_MODULES = path.resolve(__dirname, '../pg-backup/node_modules');

module.exports = defineConfig({
  plugins: [react()],
  publicDir: false,
  resolve: {
    alias: [
      { find: /^react$/, replacement: path.join(SHARED_NODE_MODULES, 'react') },
      { find: /^react\/jsx-runtime$/, replacement: path.join(SHARED_NODE_MODULES, 'react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: path.join(SHARED_NODE_MODULES, 'react/jsx-dev-runtime.js') },
      { find: /^react-dom$/, replacement: path.join(SHARED_NODE_MODULES, 'react-dom') },
      { find: /^react-dom\/client$/, replacement: path.join(SHARED_NODE_MODULES, 'react-dom/client.js') },
    ],
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:8788',
    },
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
  },
  preview: {
    port: 5174,
  },
  build: {
    outDir: 'public',
    emptyOutDir: true,
  },
});