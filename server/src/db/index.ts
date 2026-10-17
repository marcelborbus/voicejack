import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/**
 * Opens (creating if needed) the SQLite database at `file` (`:memory:` for tests) with WAL
 * journaling and foreign keys on. Uses Node's built-in `node:sqlite` (no native build).
 */
export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  return db;
}

/** Runs `fn` in a transaction (BEGIN IMMEDIATE … COMMIT, ROLLBACK on throw). */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
