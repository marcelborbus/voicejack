-- V15: privacy-friendly product analytics + feedback (#39).
-- Aggregates only: no IPs, user agents, user/player ids or room codes. Kept 2 years.
-- day = UTC date YYYY-MM-DD; dims_json = canonical JSON object (sorted keys, string values).
CREATE TABLE analytics_daily (
  day       TEXT NOT NULL,
  event     TEXT NOT NULL,
  dims_json TEXT NOT NULL DEFAULT '{}',
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event, dims_json)
);
CREATE INDEX analytics_daily_event ON analytics_daily (event, day);

-- Anonymous feedback (mood after Final, "Report a bug"): no link to a user, player or room.
-- comment: control characters stripped, at most 200 characters. Kept 1 year.
-- context_json: {phase?, route, version?, errors: [hash…]}.
CREATE TABLE feedback (
  id           INTEGER PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('mood', 'bug')),
  mood         INTEGER CHECK (mood BETWEEN 1 AND 4),
  comment      TEXT NOT NULL DEFAULT '',
  context_json TEXT NOT NULL DEFAULT '{}',
  resolved_at  INTEGER
);
CREATE INDEX feedback_created ON feedback (created_at);
