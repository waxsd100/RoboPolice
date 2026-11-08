-- Compacts the largest indexes and tunes autovacuum on high-churn tables to reduce disk usage:
-- 1. Clears embeddings on empty or unsearchable orphan messages.
-- 2. Replaces messages_guild_ts (guild_id, ts DESC), which no query orders by without channel_id,
--    with messages_guild (guild_id) so PostgreSQL B-tree deduplication compresses repeated
--    guild_id values into posting lists (~85% smaller index while still indexing the foreign key).
-- 3. Rebuilds messages_embedding_hnsw as a partial HNSW index (WHERE embedding IS NOT NULL) with
--    m = 8, ef_construction = 32 (~40-50% smaller HNSW graph, and enables HOT updates on rows
--    where embedding IS NULL).
-- 4. Lowers autovacuum_vacuum_scale_factor on frequently updated tables so dead tuples are
--    reclaimed 4-10x sooner instead of accumulating until 20% of the table has turned over.

UPDATE messages SET embedding = NULL
WHERE embedding IS NOT NULL
  AND (channel_id IS NULL OR guild_id IS NULL OR content IS NULL OR content IN ('', 'None'));

DROP INDEX IF EXISTS messages_guild_ts;
CREATE INDEX IF NOT EXISTS messages_guild ON messages (guild_id);

DROP INDEX IF EXISTS messages_embedding_hnsw;
CREATE INDEX messages_embedding_hnsw ON messages
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 8, ef_construction = 32)
  WHERE embedding IS NOT NULL;

ALTER TABLE messages SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

ALTER TABLE knowledge_sections SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE knowledge_facts SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE guild_lore_facts SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);
