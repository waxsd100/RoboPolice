-- message_embeddings repeated the message's server, channel and time; they are read from the
-- message instead.
ALTER TABLE message_embeddings DROP COLUMN guild_id, DROP COLUMN channel_id, DROP COLUMN ts;
CREATE INDEX IF NOT EXISTS messages_guild_ts ON messages (guild_id, ts DESC);
