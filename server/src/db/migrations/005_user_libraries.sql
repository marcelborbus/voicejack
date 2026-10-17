-- V06: host custom libraries. Registered users own private libraries (libraries.owner_user_id,
-- visibility 'private', from 002) and upload clips into them; the owner (admin) moderates.

-- Admin: "ban from uploading". Existing libraries stay playable, new uploads are refused.
ALTER TABLE users ADD COLUMN upload_banned INTEGER NOT NULL DEFAULT 0 CHECK (upload_banned IN (0, 1));

-- Admin: a disabled library is neither playable nor served nor listed in the lobby.
ALTER TABLE libraries ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1));

-- Takedown notice: when the uploader confirmed they hold the rights (NULL for admin uploads).
ALTER TABLE clips ADD COLUMN rights_confirmed_at INTEGER;
CREATE INDEX clips_uploaded_by ON clips (uploaded_by);

-- One row per accepted user upload (also failed ones and deleted clips), for the rolling
-- 24 h upload limit. Pruned after 2 days.
CREATE TABLE clip_uploads (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX clip_uploads_user ON clip_uploads (user_id, created_at);

-- "Report clip" from private rooms: a `reports` row (003) with context 'room', the uploader as
-- reported user and the clip's id here. Plain text: the report outlives a deleted clip.
ALTER TABLE reports ADD COLUMN clip_id TEXT;
CREATE INDEX reports_clip ON reports (clip_id) WHERE clip_id IS NOT NULL;
