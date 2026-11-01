-- The YouTube channels are the bot's, not each server's: one list for every server
-- (YOUTUBE_CHANNELS, youtubeSync.js), any number of channels. A server only chooses whether their
-- streams and uploads become its events (guild_youtube.live_events).
CREATE TABLE youtube_bot_channels (
  channel_id TEXT PRIMARY KEY REFERENCES youtube_channels (channel_id) ON DELETE CASCADE,
  -- How it is written in the setting (@name, a URL or the ID)
  channel_ref TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

-- Until the bot reads its setting at startup, the channels servers had set are kept (with their
-- videos); the startup then keeps only those named.
INSERT INTO youtube_bot_channels (channel_id, channel_ref)
  SELECT DISTINCT ON (channel_id) channel_id, channel_ref FROM guild_youtube WHERE channel_id IS NOT NULL ORDER BY channel_id, guild_id;

ALTER TABLE guild_youtube DROP COLUMN channel_ref, DROP COLUMN channel_id;
