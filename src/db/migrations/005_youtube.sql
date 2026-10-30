-- YouTube data was stored per server: a server's channel row held the channel's details, and every
-- video was copied for each server that set its channel. Channels and videos are now stored once,
-- and a server only points at its channel. Summaries are of public videos and are kept once too;
-- which server asked for which summary is recorded on its own. Push subscriptions belong to the
-- channel, so they move into its row.

ALTER TABLE youtube_channels RENAME TO old_youtube_channels;
ALTER INDEX youtube_channels_pkey RENAME TO old_youtube_channels_pkey;
ALTER TABLE youtube_videos RENAME TO old_youtube_videos;
ALTER INDEX youtube_videos_pkey RENAME TO old_youtube_videos_pkey;
ALTER TABLE youtube_summaries RENAME TO old_youtube_summaries;
ALTER INDEX youtube_summaries_pkey RENAME TO old_youtube_summaries_pkey;
ALTER TABLE youtube_live_events RENAME TO old_youtube_live_events;
ALTER INDEX youtube_live_events_pkey RENAME TO old_youtube_live_events_pkey;

CREATE TABLE youtube_channels (
  channel_id TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  handle TEXT,
  url TEXT,
  synced_at TIMESTAMPTZ,
  -- Where an interrupted read of a large channel continues (a playlistItems page token).
  backfill_token TEXT,
  -- When the push subscription (WebSub) runs out.
  websub_expires_at TIMESTAMPTZ
);
INSERT INTO youtube_channels (channel_id, title, description, handle, url, synced_at, backfill_token, websub_expires_at)
  SELECT DISTINCT ON (c.channel_id) c.channel_id, c.title, c.description, c.handle, c.url, c.synced_at, c.backfill_token, w.expires_at
  FROM old_youtube_channels c LEFT JOIN youtube_websub w ON w.channel_id = c.channel_id
  WHERE c.channel_id IS NOT NULL
  ORDER BY c.channel_id, c.synced_at DESC NULLS LAST;

-- channel_id is NULL only for rows set before channel IDs were stored, until their next sync.
CREATE TABLE guild_youtube (
  guild_id TEXT PRIMARY KEY,
  channel_ref TEXT NOT NULL,
  channel_id TEXT REFERENCES youtube_channels (channel_id),
  live_events BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX guild_youtube_channel ON guild_youtube (channel_id);
INSERT INTO guild_youtube (guild_id, channel_ref, channel_id, live_events)
  SELECT guild_id, channel_ref, channel_id, live_events FROM old_youtube_channels;

-- The URL is not stored: it is the video ID's watch page.
CREATE TABLE youtube_videos (
  video_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES youtube_channels (channel_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  published_at TIMESTAMPTZ,
  live_status TEXT,
  scheduled_start TIMESTAMPTZ,
  duration TEXT
);
CREATE INDEX youtube_videos_channel_published ON youtube_videos (channel_id, published_at DESC NULLS LAST);
INSERT INTO youtube_videos (video_id, channel_id, title, description, published_at, live_status, scheduled_start, duration)
  SELECT DISTINCT ON (v.video_id) v.video_id, c.channel_id, v.title, v.description, v.published_at, v.live_status, v.scheduled_start, v.duration
  FROM old_youtube_videos v JOIN old_youtube_channels c ON c.guild_id = v.guild_id
  WHERE c.channel_id IS NOT NULL
  ORDER BY v.video_id, c.synced_at DESC NULLS LAST;

-- A video's embedding, for searching by meaning (embeddingIndexer.js). text_hash covers the model
-- and the text it was made from, so a change to either makes it again.
CREATE TABLE youtube_video_embeddings (
  video_id TEXT PRIMARY KEY REFERENCES youtube_videos (video_id) ON DELETE CASCADE,
  embedding TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  model TEXT NOT NULL
);
INSERT INTO youtube_video_embeddings (video_id, embedding, text_hash, model)
  SELECT DISTINCT ON (v.video_id) v.video_id, v.embedding, v.embedding_hash, v.embedding_model
  FROM old_youtube_videos v JOIN youtube_videos n ON n.video_id = v.video_id
  WHERE v.embedding IS NOT NULL AND v.embedding_hash IS NOT NULL AND v.embedding_model IS NOT NULL
  ORDER BY v.video_id;

-- Keyed by video, not channel: a summary can be of any public video someone linked.
CREATE TABLE youtube_summaries (
  video_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO youtube_summaries (video_id, summary, created_at)
  SELECT DISTINCT ON (video_id) video_id, summary, created_at FROM old_youtube_summaries
  ORDER BY video_id, created_at DESC;

-- The summaries each server asked for. A summary no server refers to any more is deleted.
CREATE TABLE guild_youtube_summaries (
  guild_id TEXT NOT NULL,
  video_id TEXT NOT NULL REFERENCES youtube_summaries (video_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, video_id)
);
CREATE INDEX guild_youtube_summaries_video ON guild_youtube_summaries (video_id);
INSERT INTO guild_youtube_summaries (guild_id, video_id, created_at)
  SELECT guild_id, video_id, created_at FROM old_youtube_summaries;

-- The scheduled event made for each stream in a server, and how far it has been taken.
CREATE TABLE youtube_live_events (
  guild_id TEXT NOT NULL REFERENCES guild_youtube (guild_id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES youtube_videos (video_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'active', 'completed', 'canceled', 'gone')),
  scheduled_start TIMESTAMPTZ,
  scheduled_end TIMESTAMPTZ,
  PRIMARY KEY (guild_id, video_id)
);
CREATE INDEX youtube_live_events_video ON youtube_live_events (video_id);
INSERT INTO youtube_live_events (guild_id, video_id, event_id, status, scheduled_start, scheduled_end)
  SELECT e.guild_id, e.video_id, e.event_id, e.status, e.scheduled_start, e.scheduled_end
  FROM old_youtube_live_events e
  WHERE EXISTS (SELECT 1 FROM guild_youtube g WHERE g.guild_id = e.guild_id)
    AND EXISTS (SELECT 1 FROM youtube_videos v WHERE v.video_id = e.video_id)
    AND e.status IN ('scheduled', 'active', 'completed', 'canceled', 'gone');

DROP TABLE old_youtube_live_events, old_youtube_summaries, old_youtube_videos, old_youtube_channels, youtube_websub;
