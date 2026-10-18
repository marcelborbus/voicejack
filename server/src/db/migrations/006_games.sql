-- V09: game history for Elo (public games only; private games are never recorded).
-- kind = the queue mode the room was matched from. Timestamps are epoch milliseconds.

CREATE TABLE games (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('casual', 'ranked')),
  room_code  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX games_room ON games (room_code, created_at);

-- One row per rated player (human with an account row; bots never have one).
CREATE TABLE game_players (
  game_id    TEXT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  place      INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  elo_before INTEGER NOT NULL,
  elo_after  INTEGER NOT NULL,
  PRIMARY KEY (game_id, user_id)
);
CREATE INDEX game_players_user ON game_players (user_id);
