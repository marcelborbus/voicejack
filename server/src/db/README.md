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
  takes the guest's. The guest row stays a guest (purged by the 180-day cleanup).
  V09 game history follows the rating: when the account takes the guest's values (it had 0
  public games), the guest's `game_players` rows are reassigned to it and the guest is reset
  to 1000 / 0 games; otherwise the history stays on the guest with the guest's rating.
- **Rotation:** verify deletes every session of the claimed guest and the browser's current
  session, then issues a new one. So a link requested by someone else can't leave their
  browser signed in to your address.
- **Logout:** deletes the session row and issues a fresh guest + session.
- **Delete account:** `DELETE sessions`, pending login tokens dropped, `email=NULL`,
  `display_name=''`, `kind='guest'` (keeps the CHECK), `deleted_at=now`. The row stays (future
  references don't dangle) but never resolves again; the address can register anew.

`002_libraries.sql` (V05):

- `libraries` — `owner_user_id` NULL = official (V06 sets it for private ones), `visibility`
  official|private, `is_default` (at most one, official only), `description`.
- `clips` — `library_id` (cascade), `file`/`poster` plain names, `duration_ms`, `width`, `height`,
  `bytes`, `tags`/`attribution` JSON, `enabled`, `origin` manifest|upload (manifest = files in
  read-only CLIPS_DIR, URL `/clips/<file>`; upload = `LIBRARY_DIR/<library>/`, URL
  `/clips/<library>/<file>`), `status` processing|ready|failed + `error`, `uploaded_by` (V06
  quotas). `ClipLibrary.open` imports `clips/manifest.json` as library `classics` at every start
  (upsert by clip id: technical fields follow the manifest, admin edits are kept) and marks
  clips left `processing` by a restart as failed. Built-in clips can only be disabled.

## Host libraries (V06, `005_user_libraries.sql`, `clips/HostLibraries.ts`)

- Columns: `users.upload_banned` (admin "ban from uploading"; libraries stay playable),
  `libraries.disabled` (admin, private libraries only: not playable, not served, not listed),
  `clips.rights_confirmed_at` (uploader ticked the rights / takedown notice; NULL for admin
  uploads), `reports.clip_id` ("Report clip" rows: `context='room'`, the room code, the uploader
  as `reported_user_id`, `reported_name = 'clip: <title>'`). Table `clip_uploads`
  (`user_id`, `created_at`): one row per accepted user upload for the rolling 24 h limit (kept
  2 days).
- Quotas per registered user (`shared` `USER_MAX_*`): 5 libraries (`libraries.owner_user_id`),
  30 clips and 300 MB (`clips.uploaded_by` count / `SUM(bytes)`, every status; checked before
  the body is read, again after it arrived, and the size once more after normalizing), 10
  uploads per 24 h, 200 MB raw input. One normalize queue for admin + users
  (`ClipLibrary.jobs`): admin jobs first, at most one queued/running job per user.
- Private clip files get a random 32-hex file name (not the clip id). `/clips/<lib>/<file>` of a
  private library is served only if the request's `vj_session` cookie is the owner's or that of
  a player in a live room whose selected library it is (`Room.servesLibraryTo`); everyone else
  gets 404. Admins preview through `/api/admin/clips/:id/video|poster` (Authelia-gated).
- Rooms: only an owner who hosts may select a private library (`canUse`); public rooms have no
  human host. In the lobby `Room.enforceLibrary` resets to the default when the host can no
  longer use it (owner left, disabled, deleted). Account deletion deletes the user's libraries.

## Friends + DMs (V10, `004_friends.sql`, `friends/Friends.ts`)

Registered users only. `friendships` holds one row per pair (`user_a < user_b`), `pending` until
the other side accepts; declining, cancelling, removing and blocking delete it. `blocks` is
directional; a block in either direction stops requests, DMs and invites. `messages` are plain
text, at most 500 characters, with control/bidi characters stripped, and are deleted after
90 days by `Accounts.cleanup`. Account deletion removes the user's friendships, blocks (both
ways) and DMs (sent and received). DM reports go into V08's `reports` table with
`context='dm'`, quoting the reported message, so the quote survives the 90-day purge and the
sender's account deletion. Rate limits are kept in memory: 30 friend requests a day, 20 DMs a
minute, 10 invites a minute, 10 reports an hour.

Pending requests and blocks are addressed by `ref` = sha256 of the ordered pair, so the other
side's id is not revealed until both sides accept. A room player is only ever addressed by
`playerId`, which the server resolves through `room.userIdOf`.

**Friend search (v1.2 #44, `008_discoverable.sql`):** `users.discoverable` (default 1, switch in
the account menu). `GET /api/friends/search?q=` matches a case-insensitive (Unicode-folded via
the `vj_fold` SQL function `Friends` registers) prefix of `display_name`, at least 3 characters,
10 results, only registered, non-deleted, discoverable users with no block either way, never
the caller. Results carry the pair `ref`, a 4-character tag derived from it, and the month the
row was created, never an id or email. `POST /api/friends/add {ref}` accepts only refs the same
caller got from a search in the last 30 min (kept in memory), and re-checks the target. Limit 30
searches a minute per user (and per IP at the route).

The SQL below was the V10 plan; `004_friends.sql` is what shipped.

## Elo + game history (V09, `006_games.sql`, `elo/Ratings.ts`)

Only **public** games are recorded (casual and ranked alike); private games never touch Elo.
At FINAL the room reports every seat still on its roster (`Room` → `RoomManager.onFinal` →
`Ratings.recordGame`, synchronously before the FINAL snapshot goes out):

- `games` — `kind` casual|ranked (the queue the room was matched from), `room_code`,
  `created_at`.
- `game_players` — one row per rated player: `place` (1-based, ties share it: same total and
  round wins), `total`, `elo_before`, `elo_after`. Cascades with the user row (guest purge).
- Rated = humans with a live account row (every browser has a guest row, so guests are rated
  too). Bots and account-less seats are skipped; vote-kicked players are off the roster;
  players who disconnected (or left mid-game, which the room treats as a disconnect) still
  count with their score, so rage-quitting does not dodge a loss.
- Pairwise Elo (`elo/elo.ts`): each pair is a match (better place wins, equal = draw),
  `K = 32 / (n − 1)`, `Δ = round(K · Σ (S − E))`. `users.elo` is updated and
  `public_games_played` incremented in the same transaction, also for a lone rated player
  (Δ = 0). Ranked unlocks at 3 public games (`RANKED_MIN_GAMES`).
- `GET /api/me/last-game?room=CODE` returns the caller's row for Final.

## Analytics + feedback (V15, `007_analytics.sql`, `analytics/Analytics.ts`)

First-party, cookieless, aggregate only (#39). Nothing here holds an IP, a user agent, a
user / player id or a room code.

- `analytics_daily (day, event, dims_json, count)` — `day` is the UTC date, `dims_json` the
  canonical (sorted, string-valued) dimensions. `Analytics.track(event, dims, by)` counts in
  memory; `flush()` upserts (`count = count + excluded.count`) every 60 s and on shutdown.
  Events and their dimension keys are allow-listed in `EVENT_DIMS`; values must be short tokens.
  Clip ids are allowed (content, not people). Bots never count. Kept 2 years.
- `feedback` — mood (1–4) after Final or a "Report a bug" text, `comment` ≤ 200 chars with
  control / bidi characters stripped, `context_json` {phase, route, version, error hashes},
  `resolved_at` (admin). No user link. Kept 1 year.
- Pruned by the hourly DB cleanup (`Analytics.prune`).
- DAU / WAU / MAU and weekly cohort retention are **not** copied into analytics: the admin
  report aggregates `users.created_at` / `last_seen_at` and `game_players` ⨝ `games` with
  GROUP BY queries (`analytics/report.ts`).

## Planned migrations (not built yet)

```sql

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
