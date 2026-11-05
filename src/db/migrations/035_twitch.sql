-- The Twitch channels the bot follows (TWITCH_CHANNELS, the same for every server) and their past
-- broadcasts (archives, "VODs"), so the mention assistant knows of them (search_twitch). Twitch
-- deletes an archive after a while (7 to 60 days); a sync drops the ones it no longer lists.
CREATE TABLE twitch_channels (
  user_id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT,
  description TEXT,
  synced_at TIMESTAMPTZ
);
CREATE TABLE twitch_videos (
  video_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES twitch_channels (user_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  duration TEXT,
  view_count INTEGER
);
CREATE INDEX twitch_videos_user_published ON twitch_videos (user_id, published_at DESC NULLS LAST);
