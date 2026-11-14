// Replaces the separate embedding_models lookup table with an `embedding_model` enum type, matching
// reply_model / thinking_level / service_tier (migrations/038_reply_enums.sql, 040_guild_ai_models.sql).
// The allowed list is shared with EMBEDDING_MODELS in src/bot/utils/replyOptions.js
// (test/db/migrations.test.js checks they agree).
//
// Why `messages` is migrated outside a single transaction with `VACUUM FULL` + `CHECKPOINT` between steps:
//   On a 4.4 GB volume where `messages` (~1.5-2 GB) + `messages_embedding_hnsw` (~1.7 GB) + B-tree
//   indexes (~0.4 GB) already occupy ~3.6 GB, building all indexes inside a single transaction
//   accumulates 1+ GB of WAL in `pg_wal` before any checkpoint can recycle it, pushing total usage
//   over 5 GB and crashing Postgres. Dropping secondary indexes first, updating in batches with
//   `VACUUM`, running `VACUUM FULL messages` + `CHECKPOINT` while indexes are absent, and issuing
//   `CHECKPOINT` after each index build keeps `pg_wal` minimal so the migration stays well under 4.4 GB.

const BATCH_SIZE = 50000

async function hasColumn (client, table, column) {
  const { rows } = await client.query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = \'public\' AND table_name = $1 AND column_name = $2',
    [table, column]
  )
  return rows.length > 0
}

async function hasTable (client, table) {
  const { rows } = await client.query('SELECT to_regclass($1) AS t', [table])
  return rows[0]?.t !== null
}

module.exports = async client => {
  await client.query(`
    DO $$ BEGIN
      CREATE TYPE embedding_model AS ENUM (
        'gemini-embedding-001',
        'gemini-embedding-2-preview',
        'gemini-embedding-2',
        'text-embedding-004'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    COMMENT ON TYPE embedding_model IS 'ベクトル埋め込み（Embedding）の生成で使用可能なGeminiモデル名';
  `)

  // 1. messages (embedding_model_id -> embedding_model)
  // Drop secondary indexes first so ~2 GB of disk space is freed before any table writes or VACUUM FULL.
  await client.query(`
    DROP INDEX IF EXISTS messages_embedding_hnsw;
    DROP INDEX IF EXISTS messages_channel_ts;
    DROP INDEX IF EXISTS messages_guild_ts;
    DROP INDEX IF EXISTS messages_guild;
    DROP INDEX IF EXISTS messages_ts;
    DROP INDEX IF EXISTS messages_unembedded;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding_model embedding_model;
  `)

  // Step out of the migration runner's transaction so each step commits and `CHECKPOINT` / `VACUUM`
  // can reclaim dead tuples and recycle WAL segments immediately.
  await client.query('COMMIT')
  try {
    await client.query('CHECKPOINT').catch(() => {})

    if (await hasColumn(client, 'messages', 'embedding_model_id') && await hasTable(client, 'embedding_models')) {
      for (;;) {
        const res = await client.query(`
          WITH batch AS (
            SELECT m.id, em.name,
                   em.name = ANY (enum_range(NULL::embedding_model)::text[]) AS valid
            FROM messages m
            JOIN embedding_models em ON em.id = m.embedding_model_id
            WHERE m.embedding_model IS NULL
            LIMIT $1
          )
          UPDATE messages m
          SET embedding = CASE WHEN batch.valid THEN m.embedding ELSE NULL END,
              embedding_model = CASE WHEN batch.valid THEN batch.name::embedding_model ELSE NULL END,
              embedding_model_id = NULL
          FROM batch
          WHERE m.id = batch.id
        `, [BATCH_SIZE])
        if (res.rowCount === 0) break
        await client.query('VACUUM messages')
        await client.query('CHECKPOINT').catch(() => {})
      }
      await client.query('ALTER TABLE messages DROP COLUMN IF EXISTS embedding_model_id')
    }

    await client.query("COMMENT ON COLUMN messages.embedding_model IS '埋め込み生成（または埋め込み不要判定）を行ったEmbeddingモデル（NULLは未処理）'")
    // Compact the `messages` heap while secondary indexes are dropped (needs <1.5 GB of headroom,
    // which is available now that the 2 GB of secondary indexes are gone), then recycle WAL.
    await client.query('VACUUM FULL messages')
    await client.query('CHECKPOINT').catch(() => {})

    const messageIndexes = [
      'CREATE INDEX IF NOT EXISTS messages_channel_ts ON messages (channel_id, ts DESC)',
      'CREATE INDEX IF NOT EXISTS messages_guild ON messages (guild_id)',
      'CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts)',
      'CREATE INDEX IF NOT EXISTS messages_unembedded ON messages (ts DESC) WHERE embedding_model IS NULL',
      `CREATE INDEX IF NOT EXISTS messages_embedding_hnsw ON messages
         USING hnsw (embedding halfvec_cosine_ops)
         WITH (m = 8, ef_construction = 32)
         WHERE embedding IS NOT NULL`
    ]
    for (const ddl of messageIndexes) {
      await client.query(ddl)
      await client.query('CHECKPOINT').catch(() => {})
    }
  } finally {
    await client.query('BEGIN')
  }

  if (await hasTable(client, 'embedding_models')) {
    await client.query(`
      -- 2. youtube_videos (embedding_model_id -> embedding_model)
      DROP INDEX IF EXISTS youtube_videos_embedding_model;
      ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS embedding_model embedding_model;

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

      ALTER TABLE youtube_videos DROP COLUMN IF EXISTS embedding_model_id;
      COMMENT ON COLUMN youtube_videos.embedding_model IS '埋め込み生成に使用したEmbeddingモデル';

      -- 3. embedding_batches (model_id -> model)
      DROP INDEX IF EXISTS embedding_batches_model;

      DELETE FROM embedding_batches b
      USING embedding_models em
      WHERE em.id = b.model_id
        AND NOT em.name = ANY (enum_range(NULL::embedding_model)::text[]);

      ALTER TABLE embedding_batches ADD COLUMN IF NOT EXISTS model embedding_model;

      UPDATE embedding_batches b
      SET model = em.name::embedding_model
      FROM embedding_models em
      WHERE em.id = b.model_id;

      ALTER TABLE embedding_batches
        ALTER COLUMN model SET NOT NULL,
        DROP COLUMN IF EXISTS model_id;
      COMMENT ON COLUMN embedding_batches.model IS '埋め込み生成に使用するEmbeddingモデル';

      -- 4. guild_emojis (model_id -> embedding_model)
      DROP INDEX IF EXISTS guild_emojis_model;
      ALTER TABLE guild_emojis ADD COLUMN IF NOT EXISTS embedding_model embedding_model;

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

      ALTER TABLE guild_emojis DROP COLUMN IF EXISTS model_id;
      COMMENT ON COLUMN guild_emojis.embedding_model IS '埋め込み生成に使用したEmbeddingモデル';

      -- 5. guild_lore_facts (model_id -> embedding_model)
      DROP INDEX IF EXISTS guild_lore_facts_model;
      ALTER TABLE guild_lore_facts ADD COLUMN IF NOT EXISTS embedding_model embedding_model;

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

      ALTER TABLE guild_lore_facts DROP COLUMN IF EXISTS model_id;
      COMMENT ON COLUMN guild_lore_facts.embedding_model IS '埋め込み生成に使用したEmbeddingモデル';

      -- 6. knowledge_sections (model_id -> embedding_model)
      DROP INDEX IF EXISTS knowledge_sections_model;
      ALTER TABLE knowledge_sections ADD COLUMN IF NOT EXISTS embedding_model embedding_model;

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

      ALTER TABLE knowledge_sections DROP COLUMN IF EXISTS model_id;
      COMMENT ON COLUMN knowledge_sections.embedding_model IS '埋め込み生成に使用したEmbeddingモデル';

      -- 7. knowledge_facts (model_id -> embedding_model)
      DROP INDEX IF EXISTS knowledge_facts_model;
      ALTER TABLE knowledge_facts ADD COLUMN IF NOT EXISTS embedding_model embedding_model;

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

      ALTER TABLE knowledge_facts DROP COLUMN IF EXISTS model_id;
      COMMENT ON COLUMN knowledge_facts.embedding_model IS '埋め込み生成に使用したEmbeddingモデル';

      DROP TABLE IF EXISTS embedding_models;
    `)
  }
}
