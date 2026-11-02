-- Messages sent before the bot stored them (before it joined, or before the server set a message
-- log) are read back from each channel's history (historyBackfill.js), so the logs and the mention
-- assistant know them too. How far back each channel has been read: the oldest message read so far,
-- how many messages were read, and whether the start of the window was reached.
CREATE TABLE message_backfill (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  before_id TEXT,
  read_count INTEGER NOT NULL DEFAULT 0,
  done BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
