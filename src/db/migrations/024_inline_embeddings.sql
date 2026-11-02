-- A message's and a video's embedding are columns of their own row, not a table beside it with a
-- flag kept in step (messages.embedded): one row says it all, and it goes with its row.
--
-- embedding_model_id set means handled by that model: with embedding NULL for one that has nothing
-- to embed (empty, or from before channels were recorded). NULL means still to do.

-- Messages
ALTER TABLE messages
  ADD COLUMN embedding halfvec(512),
  ADD COLUMN embedding_model_id SMALLINT REFERENCES embedding_models (id);
UPDATE messages m SET embedding = e.embedding, embedding_model_id = e.model_id
  FROM message_embeddings e WHERE e.message_id = m.id;
-- Handled with nothing to embed: marked with the model the others were embedded with (if any; else
-- they are simply looked at again, and skipped again).
UPDATE messages SET embedding_model_id = (SELECT model_id FROM message_embeddings GROUP BY model_id ORDER BY count(*) DESC LIMIT 1)
  WHERE embedded AND embedding_model_id IS NULL;
DROP TABLE message_embeddings;
DROP INDEX IF EXISTS messages_unembedded;
ALTER TABLE messages DROP COLUMN embedded;
-- What is still to do, newest first, without a table scan.
CREATE INDEX messages_unembedded ON messages (ts DESC) WHERE embedding_model_id IS NULL;
CREATE INDEX messages_embedding_hnsw ON messages USING hnsw (embedding halfvec_cosine_ops);

-- Videos (a few thousand: scored in full, no index needed)
ALTER TABLE youtube_videos
  ADD COLUMN embedding halfvec(512),
  ADD COLUMN embedding_hash TEXT,
  ADD COLUMN embedding_model_id SMALLINT REFERENCES embedding_models (id);
UPDATE youtube_videos v SET embedding = e.embedding, embedding_hash = e.text_hash, embedding_model_id = e.model_id
  FROM youtube_video_embeddings e WHERE e.video_id = v.video_id;
DROP TABLE youtube_video_embeddings;
