-- The schema as it was before migrations, built up by generateDB.js and by the tables and columns
-- the code added on first use. Every statement is IF NOT EXISTS, so this both creates a new
-- database and brings an existing one, whatever it already had, to the same starting point.

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  content TEXT,
  attachment_b64 TEXT,
  ts TIMESTAMPTZ
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS guild_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedded BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS messages_channel_ts ON messages (channel_id, ts DESC);
CREATE INDEX IF NOT EXISTS messages_unembedded ON messages (ts DESC) WHERE NOT embedded;

CREATE TABLE IF NOT EXISTS guilds (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  ignored_channels TEXT[],
  disabled_events TEXT[],
  event_logs JSON,
  log_bots BOOL,
  custom_settings JSON
);

CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  ts TIMESTAMPTZ,
  embedding TEXT NOT NULL,
  model TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_embeddings_guild_ts ON message_embeddings (guild_id, ts DESC);

CREATE TABLE IF NOT EXISTS youtube_channels (
  guild_id TEXT PRIMARY KEY,
  channel_ref TEXT NOT NULL,
  channel_id TEXT,
  title TEXT,
  description TEXT,
  handle TEXT,
  url TEXT,
  synced_at TIMESTAMPTZ
);
ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS backfill_token TEXT;
ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS live_events BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS youtube_videos (
  guild_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  published_at TIMESTAMPTZ,
  live_status TEXT,
  scheduled_start TIMESTAMPTZ,
  duration TEXT,
  url TEXT NOT NULL,
  PRIMARY KEY (guild_id, video_id)
);
ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS embedding TEXT;
ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS embedding_hash TEXT;
ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS embedding_model TEXT;

CREATE TABLE IF NOT EXISTS youtube_summaries (
  guild_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, video_id)
);

CREATE TABLE IF NOT EXISTS youtube_live_events (
  guild_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_start TIMESTAMPTZ,
  scheduled_end TIMESTAMPTZ,
  PRIMARY KEY (guild_id, video_id)
);

CREATE TABLE IF NOT EXISTS youtube_websub (
  channel_id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
