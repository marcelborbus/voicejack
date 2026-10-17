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
- `login_tokens` — V04 magic links: `id` = sha256(emailed token), 15-min `expires_at`, single
  use (`used_at`; consuming one burns every open token for that address). `guest_user_id` is the
  guest whose cookie requested it. The per-address rate limit (3 / 15 min) counts rows by
  `(email, created_at)`.

Cleanup (hourly + at startup, `Accounts.cleanup`): expired sessions, login tokens expired for
more than 15 min (kept that long so the rate limit still sees them), guests idle > 180 days.

## Accounts (V04, `accounts/Accounts.ts`)

- **Verify, no account for the address yet:** the requesting guest row becomes
  `kind='registered'`, `email=…` (same id: Elo, games, name kept). If that guest is gone or
  meanwhile registered under another address, a new registered row is created.
- **Verify, the address already has an account (merge rule):** the browser is switched to the
  existing account, which keeps its own `elo` / `public_games_played`, except when it has
  `public_games_played = 0` and the guest has played: then it takes the guest's values
  (nothing to lose, and the guest's rating is the only real one). An empty `display_name`
  takes the guest's. The guest row stays a guest (purged by the 180-day cleanup). V09: game
  history rows of that guest are **not** moved; reassign them there if it matters.
- **Rotation:** verify deletes every session of the claimed guest and the browser's current
  session, then issues a new one. So a link requested by someone else can't leave their
  browser signed in to your address.
- **Logout:** deletes the session row and issues a fresh guest + session.
- **Delete account:** `DELETE sessions`, pending login tokens dropped, `email=NULL`,
  `display_name=''`, `kind='guest'` (keeps the CHECK), `deleted_at=now`. The row stays (future
  references don't dangle) but never resolves again; the address can register anew.

## Planned migrations (not built yet)

```sql
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
