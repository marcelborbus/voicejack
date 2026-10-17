# Database (V03)

SQLite through Node 24's built-in `node:sqlite` (`DatabaseSync`, synchronous, no native build;
no flag needed on Node 24.14, it only prints an ExperimentalWarning, silenced in the image).

- File: `DB_PATH`, default `<repo>/.cache/db/voicejack.sqlite`, prod
  `/app/data/db/voicejack.sqlite` (host `/opt/voicejack/data/db/`, **in the backups**). It must
  not be inside `DATA_DIR` (wiped on start); `startServer` refuses that. Tests use `:memory:`.
- Opened by `openDb()` (`index.ts`) with `journal_mode=WAL`, `foreign_keys=ON`,
  `synchronous=NORMAL`, `busy_timeout=5000`. `tx(db, fn)` wraps `BEGIN IMMEDIATE … COMMIT`.
- Timestamps are epoch **milliseconds** (`INTEGER`). Ids are `nanoid(16)` text. Token columns
  hold the hex SHA-256 of the secret, never the secret.

## Migrations

`migrate.ts` applies `migrations/NNN_name.sql` at startup in numeric order, each in its own
transaction together with its row in `schema_migrations (version, name, applied_at)`.

- Never edit a migration that has shipped; add the next number. One task = one migration file,
  named after the task (`002_libraries.sql`, …), so parallel tasks only collide on the number:
  take the next free one when you commit and renumber if someone beat you to it.
- No down migrations. Rolling an image back over a newer DB logs a warning (`unknown` versions)
  and keeps running, so only make additive changes that older code tolerates.
- The bundle reads them from `<dir of server.mjs>/migrations`; `deploy/bundle-server.mjs` copies
  this directory there and the Dockerfile copies it to `/app/migrations`.

## Schema

`001_users_sessions.sql` (V03):

- `users` — `kind` guest|registered, `display_name` (last name played under, `''` until the first
  join), `email` (unique, lower-cased, required for registered), `elo` 1000,
  `public_games_played`, `last_seen_at` (touched at most hourly), `deleted_at` (soft delete).
- `sessions` — `id` = sha256(cookie token), `user_id` → users (cascade), 30-day `expires_at`,
  extended on use when < 15 days remain. Cookie `vj_session`: HttpOnly, SameSite=Lax, Secure in prod.
- `login_tokens` — for V04 magic links (table only).

Cleanup (hourly + at startup, `Accounts.cleanup`): expired sessions, guests idle > 180 days.

## Planned migrations (not built yet)

```sql
-- V04 auth: no new table needed. Request: INSERT login_tokens (id = sha256(token), email,
--   guest_user_id = current guest, expires_at = now + 15 min). Verify (single use, UPDATE … SET
--   used_at WHERE used_at IS NULL): if a registered user with that email exists, move the
--   session to it (merge guest stats as decided in V04); else turn the guest row into
--   kind='registered', email=… (Elo/history kept). Logout: DELETE the session row.
--   Delete account: DELETE sessions, set email=NULL, display_name='', kind='guest'
--   (keeps the CHECK), deleted_at=now (or hard DELETE if nothing references the row).
--   Rate-limit counts can use login_tokens_email (email, created_at).

-- V05 clip libraries (admin):
-- CREATE TABLE libraries (
--   id TEXT PRIMARY KEY, name TEXT NOT NULL,
--   owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,   -- NULL = admin/public (V06 sets it)
--   visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
--   is_default INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
--   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
-- CREATE UNIQUE INDEX libraries_one_default ON libraries (is_default) WHERE is_default = 1;
-- CREATE TABLE clips (
--   id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
--   title TEXT NOT NULL, file TEXT NOT NULL,              -- relative to /app/data/clips/<libraryId>/
--   duration_ms INTEGER, width INTEGER, height INTEGER, bytes INTEGER,
--   tags TEXT NOT NULL DEFAULT '[]',                       -- JSON array
--   attribution TEXT NOT NULL DEFAULT '{}',                -- JSON {author, source, license}
--   status TEXT NOT NULL CHECK (status IN ('processing','ready','failed','disabled','removed')),
--   uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
--   created_at INTEGER NOT NULL);
-- CREATE INDEX clips_library ON clips (library_id, status);
-- (Seed: import clips/manifest.json as the default public library.)

-- V09 Elo: users.elo / public_games_played exist already. Add a history for audits:
-- CREATE TABLE games (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('public','ranked','private')),
--   started_at INTEGER NOT NULL, ended_at INTEGER, player_count INTEGER NOT NULL);
-- CREATE TABLE game_players (game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
--   user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, place INTEGER NOT NULL,
--   score INTEGER NOT NULL, elo_before INTEGER NOT NULL, elo_after INTEGER NOT NULL,
--   PRIMARY KEY (game_id, user_id));
-- Room players carry `userId` (Room.userIdOf) for exactly this; bots never have one.

-- V10 friends + DMs (registered users only):
-- CREATE TABLE friendships (
--   user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- user_a < user_b
--   user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--   requested_by TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
--   created_at INTEGER NOT NULL, accepted_at INTEGER,
--   PRIMARY KEY (user_a, user_b), CHECK (user_a < user_b));
-- CREATE TABLE blocks (blocker TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--   blocked TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
--   PRIMARY KEY (blocker, blocked));
-- CREATE TABLE messages (id INTEGER PRIMARY KEY, sender TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--   recipient TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL,
--   created_at INTEGER NOT NULL, read_at INTEGER);
-- CREATE INDEX messages_pair ON messages (recipient, sender, created_at);
-- CREATE INDEX messages_created ON messages (created_at);   -- 90-day retention purge in cleanup
-- CREATE TABLE reports (id INTEGER PRIMARY KEY, reporter TEXT REFERENCES users(id) ON DELETE SET NULL,
--   target_user TEXT REFERENCES users(id) ON DELETE SET NULL, target_clip TEXT, reason TEXT NOT NULL,
--   created_at INTEGER NOT NULL, resolved_at INTEGER);   -- shared by V08 vote-kick/report, V10, V06 takedown
```
