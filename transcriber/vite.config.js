const path = require('node:path');
const { requireToolDep, resolveToolDep } = require('./requireToolDep');

const { defineConfig } = requireToolDep('vite');
const react = requireToolDep('@vitejs/plugin-react');

module.exports = defineConfig({
  plugins: [react()],
  publicDir: false,
  resolve: {
    alias: [
      { find: /^react$/, replacement: resolveToolDep('react') },
      { find: /^react\/jsx-runtime$/, replacement: resolveToolDep('react/jsx-runtime') },
      { find: /^react\/jsx-dev-runtime$/, replacement: resolveToolDep('react/jsx-dev-runtime') },
      { find: /^react-dom$/, replacement: resolveToolDep('react-dom') },
      { find: /^react-dom\/client$/, replacement: resolveToolDep('react-dom/client') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5177,
    proxy: { '/api': 'http://localhost:8791' },
    fs: { allow: [path.resolve(__dirname, '..')] },
  },
  preview: { port: 5177 },
  build: { outDir: 'public', emptyOutDir: true },
});
