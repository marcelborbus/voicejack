import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import pkg from './package.json' with { type: 'json' };

const target = process.env.DUB_SERVER ?? 'http://localhost:3000';

/**
 * #53: zod stays out of the client bundle. The client never validates with the shared schemas
 * (only the server parses), but zod's module-level setup is not tree-shakable, so the build
 * resolves `zod` to a chainable no-op (`src/lib/zodStub.ts`). Build only: dev and unit tests
 * keep the real zod.
 */
function stubZod(): Plugin {
  const stub = fileURLToPath(new URL('./src/lib/zodStub.ts', import.meta.url));
  return {
    name: 'stub-zod',
    apply: 'build',
    enforce: 'pre',
    resolveId(id) {
      return id === 'zod' ? stub : null;
    },
  };
}

export default defineConfig({
  plugins: [stubZod(), react(), tailwindcss()],
  // V15: app version in feedback context.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/clips': { target, changeOrigin: false },
      '/ws': { target, ws: true, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // #53: React + router change rarely: one long-cached chunk next to the app entry
          // (both are modulepreloaded from index.html, so nothing waits on the other).
          groups: [
            {
              name: 'react',
              test: /[\\/]node_modules[\\/](\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(react|react-dom|scheduler|react-router|cookie|set-cookie-parser|zustand|use-sync-external-store)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
