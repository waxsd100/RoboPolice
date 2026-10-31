-- Everything stored for a server refers to its guilds row, so it goes when the server does (the
-- bot leaving it). Embedding models are a table of their own, referred to by ID.

-- Rows of servers that have no guilds row any more (the bot left them) have nothing to refer to.
DELETE FROM messages m WHERE m.guild_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM guilds g WHERE g.id = m.guild_id);
DELETE FROM guild_youtube y WHERE NOT EXISTS (SELECT 1 FROM guilds g WHERE g.id = y.guild_id);
DELETE FROM guild_youtube_summaries s WHERE NOT EXISTS (SELECT 1 FROM guilds g WHERE g.id = s.guild_id);
DELETE FROM youtube_summaries s WHERE NOT EXISTS (SELECT 1 FROM guild_youtube_summaries g WHERE g.video_id = s.video_id);
DELETE FROM youtube_channels c WHERE NOT EXISTS (SELECT 1 FROM guild_youtube g WHERE g.channel_id = c.channel_id);

-- guild_id stays NULL for messages stored before servers were recorded.
ALTER TABLE messages ADD CONSTRAINT messages_guild_fkey FOREIGN KEY (guild_id) REFERENCES guilds (id) ON DELETE CASCADE;
ALTER TABLE guild_youtube ADD CONSTRAINT guild_youtube_guild_fkey FOREIGN KEY (guild_id) REFERENCES guilds (id) ON DELETE CASCADE;
ALTER TABLE guild_youtube_summaries ADD CONSTRAINT guild_youtube_summaries_guild_fkey FOREIGN KEY (guild_id) REFERENCES guilds (id) ON DELETE CASCADE;

CREATE TABLE embedding_models (
  id SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
INSERT INTO embedding_models (name)
  SELECT model FROM message_embeddings UNION SELECT model FROM youtube_video_embeddings;

ALTER TABLE message_embeddings ADD COLUMN model_id SMALLINT REFERENCES embedding_models (id);
UPDATE message_embeddings e SET model_id = m.id FROM embedding_models m WHERE m.name = e.model;
ALTER TABLE message_embeddings ALTER COLUMN model_id SET NOT NULL, DROP COLUMN model;
CREATE INDEX message_embeddings_model ON message_embeddings (model_id);

ALTER TABLE youtube_video_embeddings ADD COLUMN model_id SMALLINT REFERENCES embedding_models (id);
UPDATE youtube_video_embeddings e SET model_id = m.id FROM embedding_models m WHERE m.name = e.model;
ALTER TABLE youtube_video_embeddings ALTER COLUMN model_id SET NOT NULL, DROP COLUMN model;
