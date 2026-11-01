-- Tidies the YouTube tables now that the channels are the bot's (020_bot_channels.sql):
--
-- 1. youtube_channels holds only the channels the bot follows, so the list of them is two columns
--    there instead of youtube_bot_channels.
-- 2. guild_youtube held one flag per server: it is a column of guilds now, and stream events refer
--    to guilds directly.
-- 3. Whether a stream's archive was summarized is one thing per video, not per server (the summary
--    is shared): when the stream ended and how often its archive was tried move to youtube_videos.
--    youtube_live_events keeps only each server's Discord event for a video.

-- 1
ALTER TABLE youtube_channels ADD COLUMN channel_ref TEXT, ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
UPDATE youtube_channels c SET channel_ref = b.channel_ref, position = b.position
  FROM youtube_bot_channels b WHERE b.channel_id = c.channel_id;
-- Channels the bot does not follow go with their videos (the bot already deleted them).
DELETE FROM youtube_channels WHERE channel_ref IS NULL;
ALTER TABLE youtube_channels ALTER COLUMN channel_ref SET NOT NULL;
DROP TABLE youtube_bot_channels;

-- 2
ALTER TABLE guilds ADD COLUMN youtube_live_events BOOLEAN NOT NULL DEFAULT false;
UPDATE guilds g SET youtube_live_events = y.live_events FROM guild_youtube y WHERE y.guild_id = g.id;
ALTER TABLE youtube_live_events DROP CONSTRAINT youtube_live_events_guild_id_fkey;
-- Every guild_youtube row had a guilds row (007_foreign_keys.sql).
ALTER TABLE youtube_live_events ADD CONSTRAINT youtube_live_events_guild_id_fkey
  FOREIGN KEY (guild_id) REFERENCES guilds (id) ON DELETE CASCADE;
DROP TABLE guild_youtube;

-- 3
ALTER TABLE youtube_videos
  ADD COLUMN stream_ended_at TIMESTAMPTZ,
  ADD COLUMN archive_attempts SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN archive_tried_at TIMESTAMPTZ;
UPDATE youtube_videos v SET stream_ended_at = e.ended_at, archive_attempts = e.attempts, archive_tried_at = e.tried_at
  FROM (SELECT video_id, min(ended_at) AS ended_at, max(archive_attempts) AS attempts, max(archive_tried_at) AS tried_at
        FROM youtube_live_events WHERE kind = 'stream' GROUP BY video_id) e
  WHERE e.video_id = v.video_id;
ALTER TABLE youtube_live_events DROP COLUMN ended_at, DROP COLUMN archive_attempts, DROP COLUMN archive_tried_at;
