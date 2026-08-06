import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Base path for GitHub Pages. Relative ('./') so emitted asset URLs resolve
// against whatever path the site is served from — this keeps the bundle
// working after a repo rename (e.g. /agent-harness-generator/ → /metaharness/)
// without rebuilding. Override with VITE_BASE=/some/path/ for an absolute base.
const base = process.env.VITE_BASE ?? './';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split stable vendor code from app code so a content change doesn't
        // bust the (larger, slower-changing) React/JSZip chunks in the CDN.
        manualChunks(id) {
          // Vite 8/Rolldown accepts the Rollup function form, not the legacy
          // object shorthand. Match both POSIX and Windows module paths.
          if (/[\\/]node_modules[\\/](react|react-dom)[\\/]/.test(id)) return 'react';
          if (/[\\/]node_modules[\\/]jszip[\\/]/.test(id)) return 'zip';
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
