// Embeddings of stored messages and YouTube videos, for searching by meaning.
//
// A message's embedding is a column of its row (migrations/024_inline_embeddings.sql), so it goes
// with the message whenever that is deleted (retention, /clearmydata, the bot leaving), and an edit
// clears it to be made again. embedding_model marks what has been handled (with the embedding NULL
// when there was nothing to embed), so finding new messages uses a small partial index.
// Videos have one vector each, on their row too.
const pool = require('../../clients/postgres')
const { toVectorLiteral } = require('../../../bot/utils/embeddings')
const { ownerGuildIDs } = require('../../../bot/utils/priority')

// Messages not handled yet and not in a running batch, in servers with message embeddings enabled
// (OWNER_GUILD_IDS by default, or guilds.embed_messages = true), those of the owner's servers first,
// then newest first: [{ id, guild_id, channel_id, ts, content }].
async function pendingMessages (limit, { after = null, before = null } = {}) {
  const rows = await pool.query(
    `SELECT id, guild_id, channel_id, ts, content FROM messages m
     WHERE embedding_model IS NULL
       AND m.embedding_batch IS NULL
       AND ($3::timestamptz IS NULL OR ts >= $3)
       AND ($4::timestamptz IS NULL OR ts < $4 OR ts IS NULL)
       AND EXISTS (SELECT 1 FROM guilds g WHERE g.id = m.guild_id AND coalesce(g.embed_messages, g.id = ANY($2)))
     ORDER BY (guild_id = ANY($2)) DESC NULLS LAST, ts DESC LIMIT $1`,
    [limit, ownerGuildIDs(), after, before])
  return rows.rows
}

// Embedding batches (migrations/028_embedding_batches.sql, 052_consolidate_tables.sql).
async function saveEmbeddingBatch (name, model, messageIDs) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    await client.query(
      "INSERT INTO gemini_batches (name, kind, model) VALUES ($1, 'embedding', $2::embedding_model::text)",
      [name, model])
    if (messageIDs.length) {
      await client.query(
        'UPDATE messages SET embedding_batch = $2 WHERE id = ANY($1::text[]) AND embedding_batch IS NULL',
        [messageIDs, name])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// [{ name, model, message_ids }], oldest first.
async function runningEmbeddingBatches () {
  const rows = await pool.query(
    `SELECT b.name, b.model, b.created_at,
            coalesce((SELECT array_agg(m.id) FROM messages m WHERE m.embedding_batch = b.name), '{}') AS message_ids
     FROM gemini_batches b
     WHERE b.kind = 'embedding'
     ORDER BY b.created_at`)
  return rows.rows
}

// Drops the batch; its messages not handled meanwhile are pending again.
// Notes where a batch stands (migrations/033_batch_status.sql): Gemini's state, or the error of a
// look that failed (the state is kept then).
async function noteEmbeddingBatch (name, { state = null, error = null } = {}) {
  await pool.query(
    "UPDATE gemini_batches SET state = coalesce($2, state), last_error = $3, checked_at = now() WHERE name = $1 AND kind = 'embedding'",
    [name, state, error ? String(error).slice(0, 500) : null])
}

async function deleteEmbeddingBatch (name) {
  await pool.query("DELETE FROM gemini_batches WHERE name = $1 AND kind = 'embedding'", [name])
}

// Stores [{ id, embedding (an Int8Array from embed()), model }] and marks `handledIds` as handled by
// `model` (which also covers messages that get no embedding, such as empty ones or ones from before
// channels were recorded). A message deleted meanwhile is simply not there to update.
async function saveMessageEmbeddings (rows, handledIds, model = rows[0]?.model) {
  for (const r of rows) {
    await pool.query('UPDATE messages SET embedding = $2, embedding_model = $3 WHERE id = $1',
      [r.id, toVectorLiteral(r.embedding), r.model])
  }
  const embedded = new Set(rows.map(r => r.id))
  const rest = handledIds.filter(id => !embedded.has(id))
  if (rest.length && model) {
    await pool.query('UPDATE messages SET embedding = NULL, embedding_model = $2 WHERE id = ANY($1)', [rest, model])
  }
}

// Up to `limit` embedded messages after `afterID` in ID order: [{ id, content }], for going over
// them all a batch at a time.
async function embeddedMessagesAfter (afterID, limit) {
  const rows = await pool.query(
    'SELECT id, content FROM messages WHERE embedding IS NOT NULL AND id > $1 ORDER BY id LIMIT $2',
    [afterID, limit])
  return rows.rows
}

// Drops the embeddings of `ids`, which stay handled (they are not embedded again).
async function dropMessageEmbeddings (ids) {
  if (ids.length === 0) return 0
  const result = await pool.query('UPDATE messages SET embedding = NULL WHERE id = ANY($1) AND embedding IS NOT NULL', [ids])
  return result.rowCount || 0
}

// Drops up to `limit` message embeddings made by another model and marks their messages to be
// embedded again (only in servers where message embeddings are enabled).
async function resetStaleMessageEmbeddings (model, limit) {
  const result = await pool.query(
    `UPDATE messages SET embedding = NULL, embedding_model = NULL
     WHERE id IN (
       SELECT m.id FROM messages m
       JOIN guilds g ON g.id = m.guild_id
       WHERE m.embedding_model <> $1
         AND coalesce(g.embed_messages, g.id = ANY($3))
       LIMIT $2
     )`,
    [model, limit, ownerGuildIDs()])
  return result.rowCount || 0
}

// An edited message is embedded again.
async function invalidateMessage (messageID) {
  await pool.query('UPDATE messages SET embedding = NULL, embedding_model = NULL WHERE id = $1', [messageID])
}

// Settings for one nearest-neighbour query, run inside its transaction. The HNSW index finds
// neighbours first and filters (server, channels, model) after; pgvector 0.8 and later keep
// scanning until enough rows pass the filter. Older versions would return too few, so they scan
// exactly instead.
let iterative = null
async function prepareSearch (client, limit) {
  if (iterative === null) {
    const version = (await client.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'")).rows[0]?.extversion || '0'
    const [major, minor] = version.split('.').map(Number)
    iterative = major > 0 || minor >= 8
  }
  if (iterative) {
    await client.query("SET LOCAL hnsw.iterative_scan = 'strict_order'")
    await client.query(`SET LOCAL hnsw.ef_search = ${Math.max(40, Math.min(1000, limit))}`)
  } else {
    await client.query('SET LOCAL enable_indexscan = off')
  }
}

// The `limit` stored messages of a server in `channelIDs` closest to the vector `query`, made by
// `model`: [{ message_id, score }] best first, score the cosine similarity.
async function nearestMessages (guildID, channelIDs, query, { model, limit = 60 } = {}) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    await prepareSearch(client, limit)
    const rows = (await client.query(
      `SELECT id AS message_id, 1 - (embedding <=> $4::halfvec) AS score FROM messages
       WHERE guild_id = $1 AND channel_id = ANY($2) AND embedding_model = $3 AND embedding IS NOT NULL
       ORDER BY embedding <=> $4::halfvec LIMIT $5`,
      [guildID, channelIDs, model, toVectorLiteral(query), limit])).rows
    await client.query('COMMIT')
    return rows.map(r => ({ message_id: r.message_id, score: Number(r.score) }))
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// Messages by ID: [{ id, author_id, channel_id, ts, content }].
async function getMessages (ids) {
  if (ids.length === 0) return []
  const rows = await pool.query('SELECT id, author_id, channel_id, ts, content FROM messages WHERE id = ANY($1)', [ids])
  return rows.rows
}

// Every stored video with what its embedding is made from, newest first:
// [{ video_id, title, description, summary, text_hash }].
async function videosForEmbedding () {
  const rows = await pool.query(
    `SELECT v.video_id, v.title, v.description, v.summary, v.embedding_hash AS text_hash
     FROM youtube_videos v
     WHERE v.channel_id IS NOT NULL
     ORDER BY v.published_at DESC NULLS LAST`)
  return rows.rows
}

async function saveVideoEmbedding (videoID, embedding, hash, model) {
  // A video gone meanwhile (its channel was unset) is simply not there to update.
  await pool.query(
    'UPDATE youtube_videos SET embedding = $2, embedding_hash = $3, embedding_model = $4 WHERE video_id = $1 AND channel_id IS NOT NULL',
    [videoID, toVectorLiteral(embedding), hash, model])
}

// Whether any video of the bot's channels has an embedding made by `model` (the channels are the
// same for every server; guildID is kept for the callers).
async function hasVideoEmbeddings (guildID, model) {
  const rows = await pool.query(
    'SELECT 1 FROM youtube_videos WHERE channel_id IS NOT NULL AND embedding_model = $1 AND embedding IS NOT NULL LIMIT 1',
    [model])
  return rows.rows.length !== 0
}

// { video_id: score } for the videos of the bot's channels that have an embedding made by `model`,
// score the cosine similarity to the vector `query`. The channels have at most a few thousand
// videos each, so all are scored.
async function videoScores (guildID, query, model) {
  const rows = await pool.query(
    'SELECT video_id, 1 - (embedding <=> $2::halfvec) AS score FROM youtube_videos WHERE channel_id IS NOT NULL AND embedding_model = $1 AND embedding IS NOT NULL',
    [model, toVectorLiteral(query)])
  return Object.fromEntries(rows.rows.map(r => [r.video_id, Number(r.score)]))
}

module.exports = { noteEmbeddingBatch, saveEmbeddingBatch, runningEmbeddingBatches, deleteEmbeddingBatch, pendingMessages, saveMessageEmbeddings, embeddedMessagesAfter, dropMessageEmbeddings, resetStaleMessageEmbeddings, invalidateMessage, nearestMessages, getMessages, videosForEmbedding, saveVideoEmbedding, hasVideoEmbeddings, videoScores }
