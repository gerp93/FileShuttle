import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: the engine/db/service tests run
// under plain Node (no Electron, no DOM) against real temp directories.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
