-- Tunes autovacuum on high-churn tables so dead tuples are reclaimed 4-10x sooner instead of
-- accumulating until 20% of the table has turned over, and ensures the HNSW index exists.
-- (Full index compaction / VACUUM FULL is handled offline by src/miscellaneous/compactDb.js so
-- startup migrations complete in milliseconds without OOM-killing Postgres.)

CREATE INDEX IF NOT EXISTS messages_embedding_hnsw ON messages
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
