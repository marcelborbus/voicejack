-- V10: friends, blocks, direct messages (registered users only). Epoch-ms timestamps.

-- One row per pair, stored with user_a < user_b. 'pending' until the other side accepts;
-- requested_by is the side that asked. Declining / cancelling / removing deletes the row.
CREATE TABLE friendships (
  user_a       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at   INTEGER NOT NULL,
  accepted_at  INTEGER,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b),
  CHECK (requested_by IN (user_a, user_b))
);
CREATE INDEX friendships_b ON friendships (user_b);
CREATE INDEX friendships_requested ON friendships (requested_by, created_at);

CREATE TABLE blocks (
  blocker    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker, blocked)
);
CREATE INDEX blocks_blocked ON blocks (blocked);

-- Kept 90 days (Accounts.cleanup). body: plain text ≤ 500 chars, control characters stripped.
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  sender     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX messages_pair ON messages (recipient, sender, created_at);
CREATE INDEX messages_sender ON messages (sender, recipient, created_at);
CREATE INDEX messages_created ON messages (created_at);

-- DM reports go into V08's `reports` table (003_reports.sql) with context = 'dm'.
