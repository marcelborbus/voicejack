-- V03: users (guest + registered), sessions, magic-link tokens (used from V04).
-- All timestamps are epoch milliseconds (INTEGER).

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL DEFAULT 'guest' CHECK (kind IN ('guest', 'registered')),
  -- Last name the user played under ('' until the first room join).
  display_name        TEXT NOT NULL DEFAULT '',
  -- Lower-cased; only registered users have one (V04).
  email               TEXT UNIQUE,
  created_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  elo                 INTEGER NOT NULL DEFAULT 1000,
  public_games_played INTEGER NOT NULL DEFAULT 0,
  -- Soft delete (V04 account deletion anonymizes the row and sets this).
  deleted_at          INTEGER,
  CHECK (kind = 'guest' OR email IS NOT NULL)
);
CREATE INDEX users_kind_last_seen ON users (kind, last_seen_at);

-- id = hex SHA-256 of the cookie token; the token itself is never stored.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Magic-link tokens (V04): 15 min, single use. id = hex SHA-256 of the emailed token.
-- guest_user_id is the guest that requested the link; verifying claims that guest row.
CREATE TABLE login_tokens (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  guest_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);
CREATE INDEX login_tokens_email ON login_tokens (email, created_at);
CREATE INDEX login_tokens_expires ON login_tokens (expires_at);
