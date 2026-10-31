-- When a stream's event was completed, and how often its archive was tried for a summary
-- (liveWatcher.js summarizes the archive once YouTube has it).
ALTER TABLE youtube_live_events
  ADD COLUMN ended_at TIMESTAMPTZ,
  ADD COLUMN archive_attempts SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN archive_tried_at TIMESTAMPTZ;
