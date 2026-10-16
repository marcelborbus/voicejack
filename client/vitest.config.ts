import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Client unit tests run in node; DOM/browser APIs are faked per test where needed.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    name: 'client',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
