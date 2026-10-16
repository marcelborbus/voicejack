import { defineConfig } from 'vitest/config';

// Root test runner: each workspace package is a vitest project. A package may add its own
// vitest.config.ts (e.g. client with jsdom); it is picked up automatically.
export default defineConfig({
  test: {
    projects: ['shared', 'server', 'client'],
    passWithNoTests: true,
  },
});
