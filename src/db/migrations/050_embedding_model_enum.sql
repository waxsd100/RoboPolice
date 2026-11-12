-- Replaces the separate embedding_models lookup table with an `embedding_model` enum type, matching
-- reply_model / thinking_level / service_tier (migrations/038_reply_enums.sql, 040_guild_ai_models.sql).
-- The allowed list is shared with EMBEDDING_MODELS in src/bot/utils/replyOptions.js
-- (test/db/migrations.test.js checks they agree).
--
-- Columns are migrated via ADD COLUMN + targeted UPDATE + DROP COLUMN (dropping messages_unembedded
-- beforehand and recreating it after) rather than ALTER COLUMN TYPE, so PostgreSQL never rewrites
-- the messages heap or rebuilds messages_embedding_hnsw at startup.

CREATE TYPE embedding_model AS ENUM (
  'gemini-embedding-001',
  'gemini-embedding-2-preview',
  'gemini-embedding-2',
  'text-embedding-004'
);

COMMENT ON TYPE embedding_model IS 'ベクトル埋め込み（Embedding）の生成で使用可能なGeminiモデル名';

-- 1. messages (embedding_model_id -> embedding_model)
DROP INDEX IF EXISTS messages_unembedded;
ALTER TABLE messages ADD COLUMN embedding_model embedding_model;

UPDATE messages m
SET embedding = NULL
FROM embedding_models em
WHERE em.id = m.embedding_model_id
  AND NOT em.name = ANY (enum_range(NULL::embedding_model)::text[]);

UPDATE messages m
SET embedding_model = em.name::embedding_model
FROM embedding_models em
WHERE em.id = m.embedding_model_id
  AND em.name = ANY (enum_range(NULL::embedding_model)::text[]);

ALTER TABLE messages DROP COLUMN embedding_model_id;
CREATE INDEX messages_unembedded ON messages (ts DESC) WHERE embedding_model IS NULL;
COMMENT ON COLUMN messages.embedding_model IS '埋め込み生成（または埋め込み不要判定）を行ったEmbeddingモデル（NULLは未処理）';

-- 2. youtube_videos (embedding_model_id -> embedding_model)
DROP INDEX IF EXISTS youtube_videos_embedding_model;
ALTER TABLE youtube_videos ADD COLUMN embedding_model embedding_model;

UPDATE youtube_videos v
SET embedding = NULL, embedding_hash = NULL
FROM embedding_models em
WHERE em.id = v.embedding_model_id
  AND NOT em.name = ANY (enum_range(NULL::embedding_model)::text[]);

UPDATE youtube_videos v
SET embedding_model = em.name::embedding_model
FROM embedding_models em
WHERE em.id = v.embedding_model_id
  AND em.name = ANY (enum_range(NULL::embedding_model)::text[]);

ALTER TABLE youtube_videos DROP COLUMN embedding_model_id;
COMMENT ON COLUMN youtube_videos.embedding_model IS '埋め込み生成に使用したEmbeddingモデル';

-- 3. embedding_batches (model_id -> model)
DROP INDEX IF EXISTS embedding_batches_model;

DELETE FROM embedding_batches b
USING embedding_models em
WHERE em.id = b.model_id
  AND NOT em.name = ANY (enum_range(NULL::embedding_model)::text[]);

ALTER TABLE embedding_batches ADD COLUMN model embedding_model;

UPDATE embedding_batches b
SET model = em.name::embedding_model
FROM embedding_models em
WHERE em.id = b.model_id;

ALTER TABLE embedding_batches
  ALTER COLUMN model SET NOT NULL,
  DROP COLUMN model_id;
COMMENT ON COLUMN embedding_batches.model IS '埋め込み生成に使用するEmbeddingモデル';

-- 4. guild_emojis (model_id -> embedding_model)
DROP INDEX IF EXISTS guild_emojis_model;
ALTER TABLE guild_emojis ADD COLUMN embedding_model embedding_model;

UPDATE guild_emojis e
SET embedding = NULL
FROM embedding_models em
WHERE em.id = e.model_id
  AND NOT em.name = ANY (enum_range(NULL::embedding_model)::text[]);

UPDATE guild_emojis e
SET embedding_model = em.name::embedding_model
FROM embedding_models em
WHERE em.id = e.model_id
  AND em.name = ANY (enum_range(NULL::embedding_model)::text[]);

ALTER TABLE guild_emojis DROP COLUMN model_id;
COMMENT ON COLUMN guild_emojis.embedding_model IS '埋め込み生成に使用したEmbeddingモデル';

-- 5. guild_lore_facts (model_id -> embedding_model)
DROP INDEX IF EXISTS guild_lore_facts_model;
ALTER TABLE guild_lore_facts ADD COLUMN embedding_model embedding_model;

UPDATE guild_lore_facts f
SET embedding = NULL
FROM embedding_models em
WHERE em.id = f.model_id
  AND NOT em.name = ANY (enum_range(NULL::embedding_model)::text[]);

UPDATE guild_lore_facts f
SET embedding_model = em.name::embedding_model
FROM embedding_models em
WHERE em.id = f.model_id
  AND em.name = ANY (enum_range(NULL::embedding_model)::text[]);

ALTER TABLE guild_lore_facts DROP COLUMN model_id;
COMMENT ON COLUMN guild_lore_facts.embedding_model IS '埋め込み生成に使用したEmbeddingモデル';

-- 6. knowledge_sections (model_id -> embedding_model)
DROP INDEX IF EXISTS knowledge_sections_model;
ALTER TABLE knowledge_sections ADD COLUMN embedding_model embedding_model;

UPDATE knowledge_sections s
SET embedding = NULL
FROM embedding_models em
WHERE em.id = s.model_id
  AND NOT em.name = ANY (enum_range(NULL::embedding_model)::text[]);

UPDATE knowledge_sections s
SET embedding_model = em.name::embedding_model
FROM embedding_models em
WHERE em.id = s.model_id
  AND em.name = ANY (enum_range(NULL::embedding_model)::text[]);

ALTER TABLE knowledge_sections DROP COLUMN model_id;
COMMENT ON COLUMN knowledge_sections.embedding_model IS '埋め込み生成に使用したEmbeddingモデル';

-- 7. knowledge_facts (model_id -> embedding_model)
DROP INDEX IF EXISTS knowledge_facts_model;
ALTER TABLE knowledge_facts ADD COLUMN embedding_model embedding_model;

UPDATE knowledge_facts f
SET embedding = NULL
FROM embedding_models em
WHERE em.id = f.model_id
  AND NOT em.name = ANY (enum_range(NULL::embedding_model)::text[]);

UPDATE knowledge_facts f
SET embedding_model = em.name::embedding_model
FROM embedding_models em
WHERE em.id = f.model_id
  AND em.name = ANY (enum_range(NULL::embedding_model)::text[]);

ALTER TABLE knowledge_facts DROP COLUMN model_id;
COMMENT ON COLUMN knowledge_facts.embedding_model IS '埋め込み生成に使用したEmbeddingモデル';

DROP TABLE embedding_models;
