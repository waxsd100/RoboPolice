-- Messages sent before the bot stored them (before it joined, or before the server set a message
-- log) are read back from each channel's history (historyBackfill.js), so the logs and the mention
-- assistant know them too. How far back each channel has been read: the oldest message read so far,
-- how many messages were read, and whether it stopped (done) and why: at the start of the channel
-- (reached_start, nothing more to read) or at the limits it was read with (limit_start, the oldest
-- time; limit_max, the most messages; NULL for none), so wider limits later read on from there.
CREATE TABLE message_backfill (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  before_id TEXT,
  read_count INTEGER NOT NULL DEFAULT 0,
  done BOOLEAN NOT NULL DEFAULT false,
  reached_start BOOLEAN NOT NULL DEFAULT false,
  limit_start TIMESTAMPTZ,
  limit_max INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
