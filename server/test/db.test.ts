import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { loadMigrations, migrate, type Migration } from '../src/db/migrate.js';
import { tmpDir } from './helpers.js';

function tmpDb() {
  return openDb(path.join(tmpDir('vj-db-'), 'nested/dir/test.sqlite'));
}

describe('openDb', () => {
  it('creates the file in WAL mode with foreign keys on', () => {
    const dir = tmpDir('vj-db-');
    const file = path.join(dir, 'a/b.sqlite');
    const db = openDb(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    db.close();
  });
});

describe('migrate', () => {
  it('applies the bundled migrations once and records them', () => {
    const db = tmpDb();
    const files = loadMigrations();
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]!.version).toBe(1);
    const r1 = migrate(db);
    expect(r1.applied).toEqual(files.map((f) => f.name));
    expect(r1.version).toBe(files.at(-1)!.version);
    const r2 = migrate(db);
    expect(r2.applied).toEqual([]);
    expect(r2.version).toBe(r1.version);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(['schema_migrations', 'users', 'sessions', 'login_tokens']),
    );
    db.close();
  });

  it('users defaults and constraints', () => {
    const db = tmpDb();
    migrate(db);
    db.prepare("INSERT INTO users (id, created_at, last_seen_at) VALUES ('u1', 1, 1)").run();
    expect(db.prepare("SELECT * FROM users WHERE id = 'u1'").get()).toMatchObject({
      kind: 'guest',
      display_name: '',
      email: null,
      elo: 1000,
      public_games_played: 0,
      deleted_at: null,
    });
    // Registered users need an email; emails are unique.
    expect(() =>
      db
        .prepare(
          "INSERT INTO users (id, kind, created_at, last_seen_at) VALUES ('u2', 'registered', 1, 1)",
        )
        .run(),
    ).toThrow();
    const reg = db.prepare(
      "INSERT INTO users (id, kind, email, created_at, last_seen_at) VALUES (?, 'registered', ?, 1, 1)",
    );
    reg.run('u3', 'a@example.com');
    expect(() => reg.run('u4', 'a@example.com')).toThrow(/UNIQUE/);
    // Sessions need an existing user and cascade on delete.
    expect(() => db.prepare("INSERT INTO sessions VALUES ('h', 'nobody', 1, 2)").run()).toThrow(
      /FOREIGN KEY/,
    );
    db.prepare("INSERT INTO sessions VALUES ('h', 'u1', 1, 2)").run();
    db.prepare("DELETE FROM users WHERE id = 'u1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    db.close();
  });

  it('applies only new migrations, and rolls back a failing one', () => {
    const db = tmpDb();
    const m: Migration[] = [{ version: 1, name: '001_a.sql', sql: 'CREATE TABLE a (x);' }];
    expect(migrate(db, m).applied).toEqual(['001_a.sql']);
    m.push({ version: 2, name: '002_b.sql', sql: 'CREATE TABLE b (x);' });
    expect(migrate(db, m).applied).toEqual(['002_b.sql']);
    m.push({
      version: 3,
      name: '003_bad.sql',
      sql: 'CREATE TABLE c (x); SELECT nope FROM nothing;',
    });
    expect(() => migrate(db, m)).toThrow(/003_bad\.sql/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'c'").get()).toBeUndefined();
    const r = migrate(db, m.slice(0, 2));
    expect(r.version).toBe(2);
    // A DB that is newer than the build reports the unknown versions instead of failing.
    expect(migrate(db, m.slice(0, 1)).unknown).toEqual([2]);
    db.close();
  });

  it('loads NNN_*.sql in numeric order and rejects duplicate versions', () => {
    const dir = tmpDir('vj-mig-');
    fs.writeFileSync(path.join(dir, '010_c.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(dir, '002_b.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(dir, 'README.md'), 'ignored');
    expect(loadMigrations(dir).map((x) => x.version)).toEqual([2, 10]);
    fs.writeFileSync(path.join(dir, '002_dup.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/duplicate/);
  });
});
