-- V05: clip libraries. Official libraries are managed on /admin; V06 adds private ones
-- (owner_user_id set, visibility 'private'). The built-in `clips/manifest.json` is imported at
-- startup as the official library `classics` (origin 'manifest', files in read-only CLIPS_DIR);
-- uploads (origin 'upload') live in LIBRARY_DIR/<library_id>/.

CREATE TABLE libraries (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,   -- NULL = official
  visibility    TEXT NOT NULL CHECK (visibility IN ('official', 'private')),
  is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK (is_default = 0 OR visibility = 'official')
);
CREATE UNIQUE INDEX libraries_one_default ON libraries (is_default) WHERE is_default = 1;
CREATE INDEX libraries_owner ON libraries (owner_user_id);

CREATE TABLE clips (
  id          TEXT PRIMARY KEY,
  library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  file        TEXT NOT NULL,                     -- plain file name (CLIPS_DIR or LIBRARY_DIR/<lib>/)
  poster      TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  width       INTEGER NOT NULL DEFAULT 0,
  height      INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  tags        TEXT NOT NULL DEFAULT '[]',        -- JSON array of strings
  attribution TEXT NOT NULL DEFAULT '{}',        -- JSON {author, source, license, licenseUrl?}
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  origin      TEXT NOT NULL CHECK (origin IN ('manifest', 'upload')),
  status      TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed')),
  error       TEXT,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,  -- V06 quotas
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX clips_library ON clips (library_id, enabled, status);
CREATE UNIQUE INDEX clips_library_file ON clips (library_id, file);
