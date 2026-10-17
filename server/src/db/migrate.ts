import fs from 'node:fs';
import path from 'node:path';
import { tx, type Db } from './index.js';

/**
 * Directory with the numbered `NNN_name.sql` files. In the bundled image `import.meta.dirname`
 * is `/app`, and deploy/bundle-server.mjs copies the migrations next to `server.mjs`.
 */
export const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

const FILE_RE = /^(\d+)_[\w-]+\.sql$/;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  if (!fs.existsSync(dir)) throw new Error(`migrations dir not found: ${dir}`);
  const out: Migration[] = [];
  for (const name of fs.readdirSync(dir)) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    out.push({ version: Number(m[1]), name, sql: fs.readFileSync(path.join(dir, name), 'utf8') });
  }
  out.sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.version === out[i - 1]!.version) {
      throw new Error(`duplicate migration version ${out[i]!.version}`);
    }
  }
  return out;
}

export interface MigrateResult {
  /** File names applied by this run, in order. */
  applied: string[];
  /** Highest version in the DB afterwards. */
  version: number;
  /** Versions recorded in the DB that have no file (DB is newer than this build). */
  unknown: number[];
}

/**
 * Applies every migration not yet recorded in `schema_migrations` (in version order), each in its own
 * transaction together with its `schema_migrations` row. Idempotent; run at startup.
 */
export function migrate(
  db: Db,
  migrations: Migration[] = loadMigrations(),
  now: () => number = Date.now,
): MigrateResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const done = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const applied: string[] = [];
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    try {
      tx(db, () => {
        db.exec(m.sql);
        insert.run(m.version, m.name, now());
      });
    } catch (e) {
      throw new Error(`migration ${m.name} failed: ${(e as Error).message}`, { cause: e });
    }
    done.add(m.version);
    applied.push(m.name);
  }
  const known = new Set(migrations.map((m) => m.version));
  return {
    applied,
    version: Math.max(0, ...done),
    unknown: [...done].filter((v) => !known.has(v)).sort((a, b) => a - b),
  };
}
