-- V08: player reports, shared by public games (V08, context 'room') and DMs (V10, 'dm'). Written by the server only; reviewed by
-- the owner (sqlite3 / admin). Names are snapshots (room names are not account data); user ids
-- are nulled when the account row goes away (guest purge, account deletion).

CREATE TABLE reports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at       INTEGER NOT NULL,
  context          TEXT NOT NULL DEFAULT 'room' CHECK (context IN ('room', 'dm')),
  room_code        TEXT,                          -- NULL for DM reports
  reporter_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reporter_name    TEXT NOT NULL,
  reported_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reported_name    TEXT NOT NULL,
  reason           TEXT NOT NULL,
  resolved_at      INTEGER
);
CREATE INDEX reports_created ON reports (created_at);
CREATE INDEX reports_reported_user ON reports (reported_user_id);
