// Bundles server/src/main.ts (plus @dub/shared, which has no build step, and every npm
// dependency) into one ESM file for the production image (PLAN T01 NOTE / T20).
// esbuild is not a direct dependency; it is resolved through tsx, which depends on it.
// Usage: node deploy/bundle-server.mjs <outfile>
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outfile = path.resolve(process.argv[2] ?? path.join(root, 'dist/server/server.mjs'));

const fromServer = createRequire(path.join(root, 'server/package.json'));
const fromTsx = createRequire(fromServer.resolve('tsx/package.json'));
const esbuild = await import(fromTsx.resolve('esbuild'));

const result = await esbuild.build({
  entryPoints: [path.join(root, 'server/src/main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  keepNames: true,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
  // Optional native speedups that ws try-requires; absent at runtime is fine.
  external: ['bufferutil', 'utf-8-validate'],
  // CJS deps (fastify, pino, ...) call require() for node builtins.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
// SQL migrations are read at runtime from `<dir of server.mjs>/migrations` (server/src/db/migrate.ts).
const migrationsOut = path.join(path.dirname(outfile), 'migrations');
fs.rmSync(migrationsOut, { recursive: true, force: true });
fs.cpSync(path.join(root, 'server/src/db/migrations'), migrationsOut, { recursive: true });
console.log(`copied migrations → ${migrationsOut} (${fs.readdirSync(migrationsOut).join(', ')})`);
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`bundled server → ${outfile} (${(bytes / 1024).toFixed(0)} KiB)`);
