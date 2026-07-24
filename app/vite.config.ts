import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Node server (src/server.ts) serves the built output from app/dist at the
// chat URL, so there is no dev server in normal use — `jam open` runs the
// packaged build. `base: '/'` keeps asset URLs absolute under the root the
// server mounts.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
