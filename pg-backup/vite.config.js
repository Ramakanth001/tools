const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');

// Vite runs on 5173 by default. We proxy API calls to the Express server on 8787.
module.exports = defineConfig({
  plugins: [react()],
  // Avoid Vite treating /public as static files folder since we also build into it.
  publicDir: false,
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
