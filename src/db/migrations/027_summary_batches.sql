-- Video summaries asked for with /youtube summarize go to Gemini's Batch API (half the price, done
-- within a day). A row per batch still running, so a restart goes on watching it; dropped when the
-- batch is done and the server has been told.
CREATE TABLE youtube_summary_batches (
  name TEXT PRIMARY KEY, -- Gemini's batches/…
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  channel_id TEXT, -- where to say it is done
  requester_id TEXT,
  video_ids TEXT[] NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
