-- New uploads become events too (liveWatcher.js), kept apart from streams: an upload's event is
-- not followed like a stream's, and its "archive" is not summarized.
ALTER TABLE youtube_live_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'stream' CHECK (kind IN ('stream', 'upload'));
