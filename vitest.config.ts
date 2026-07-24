// Vitest config for jam. Tests cover the pure, logic-dense backend units — the
// session store's park/deliver/end handoff and the session-id minting. Everything
// runs in plain Node (no DOM), so the default environment is left as-is. The app's
// vite.config.ts is separate (it builds the browser bundle); Vitest reads only
// this file.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'app/src/**/*.test.ts'],
  },
});
