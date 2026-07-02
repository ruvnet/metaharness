import { defineConfig } from 'vite';

// Relative base so the built demo works from any static-host subpath
// (e.g. GitHub Pages) per ADR-0005.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
  },
});
