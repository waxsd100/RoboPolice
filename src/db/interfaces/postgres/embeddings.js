// Embeddings of stored messages and YouTube videos, for searching by meaning.
//
// A message's embedding is a column of its row (migrations/024_inline_embeddings.sql), so it goes
// with the message whenever that is deleted (retention, /clearmydata, the bot leaving), and an edit
// clears it to be made again. embedding_model_id marks what has been handled (with the embedding
// NULL when there was nothing to embed), so finding new messages uses a small partial index.
// Videos have one vector each, on their row too.
const pool = require('../../clients/postgres')
const { toVectorLiteral } = require('../../../bot/utils/embeddings')
const { ownerGuildIDs } = require('../../../bot/utils/priority')

// Embedding models by name -> ID in embedding_models. A model is added the first time it is used.
const modelIds = new Map()
async function modelId (name) {
  if (!modelIds.has(name)) {
    const rows = await pool.query(
      `WITH added AS (INSERT INTO embedding_models (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id)
       SELECT id FROM added UNION ALL SELECT id FROM embedding_models WHERE name = $1`,
      [name])
    modelIds.set(name, rows.rows[0].id)
  }
  return modelIds.get(name)
}

// Messages not handled yet and not in a running batch, those of the owner's servers first, then
// newest first: [{ id, guild_id, channel_id, ts, content }]. after: only those sent since then;
// before: only those sent before then (or at no known time).
async function pendingMessages (limit, { after = null, before = null } = {}) {
  const rows = await pool.query(
    `SELECT id, guild_id, channel_id, ts, content FROM messages m
     WHERE embedding_model_id IS NULL
       AND ($3::timestamptz IS NULL OR ts >= $3)
       AND ($4::timestamptz IS NULL OR ts < $4 OR ts IS NULL)
       AND NOT EXISTS (SELECT 1 FROM embedding_batch_messages b WHERE b.message_id = m.id)
     ORDER BY (guild_id = ANY($2)) DESC NULLS LAST, ts DESC LIMIT $1`,
    [limit, ownerGuildIDs(), after, before])
  return rows.rows
}

// Embedding batches (migrations/028_embedding_batches.sql).
async function saveEmbeddingBatch (name, model, messageIDs) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    await client.query('INSERT INTO embedding_batches (name, model_id) VALUES ($1, $2)', [name, await modelId(model)])
    await client.query('INSERT INTO embedding_batch_messages (message_id, batch_name) SELECT unnest($1::text[]), $2 ON CONFLICT DO NOTHING', [messageIDs, name])
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
    `SELECT b.name, em.name AS model, b.created_at, coalesce(array_agg(m.message_id) FILTER (WHERE m.message_id IS NOT NULL), '{}') AS message_ids
     FROM embedding_batches b JOIN embedding_models em ON em.id = b.model_id
     LEFT JOIN embedding_batch_messages m ON m.batch_name = b.name
     GROUP BY b.name, em.name, b.created_at ORDER BY b.created_at`)
  return rows.rows
}

// Drops the batch; its messages not handled meanwhile are pending again.
// Notes where a batch stands (migrations/033_batch_status.sql): Gemini's state, or the error of a
// look that failed (the state is kept then).
async function noteEmbeddingBatch (name, { state = null, error = null } = {}) {
  await pool.query(
    'UPDATE embedding_batches SET state = coalesce($2, state), last_error = $3, checked_at = now() WHERE name = $1',
    [name, state, error ? String(error).slice(0, 500) : null])
}

async function deleteEmbeddingBatch (name) {
  await pool.query('DELETE FROM embedding_batches WHERE name = $1', [name])
}

// Stores [{ id, embedding (an Int8Array from embed()), model }] and marks `handledIds` as handled by
// `model` (which also covers messages that get no embedding, such as empty ones or ones from before
// channels were recorded). A message deleted meanwhile is simply not there to update.
async function saveMessageEmbeddings (rows, handledIds, model = rows[0]?.model) {
  for (const r of rows) {
    await pool.query('UPDATE messages SET embedding = $2, embedding_model_id = $3 WHERE id = $1',
      [r.id, toVectorLiteral(r.embedding), await modelId(r.model)])
  }
  const embedded = new Set(rows.map(r => r.id))
  const rest = handledIds.filter(id => !embedded.has(id))
  if (rest.length && model) {
    await pool.query('UPDATE messages SET embedding = NULL, embedding_model_id = $2 WHERE id = ANY($1)', [rest, await modelId(model)])
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
// embedded again. Resolves to how many were dropped.
async function resetStaleMessageEmbeddings (model, limit) {
  const result = await pool.query(
    `UPDATE messages SET embedding = NULL, embedding_model_id = NULL
     WHERE id IN (SELECT id FROM messages WHERE embedding_model_id <> $1 LIMIT $2)`,
    [await modelId(model), limit])
  return result.rowCount || 0
}

// An edited message is embedded again.
async function invalidateMessage (messageID) {
  await pool.query('UPDATE messages SET embedding = NULL, embedding_model_id = NULL WHERE id = $1', [messageID])
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
       WHERE guild_id = $1 AND channel_id = ANY($2) AND embedding_model_id = $3 AND embedding IS NOT NULL
       ORDER BY embedding <=> $4::halfvec LIMIT $5`,
      [guildID, channelIDs, await modelId(model), toVectorLiteral(query), limit])).rows
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
    `SELECT v.video_id, v.title, v.description, s.summary, v.embedding_hash AS text_hash FROM youtube_videos v
     LEFT JOIN youtube_summaries s ON s.video_id = v.video_id
     ORDER BY v.published_at DESC NULLS LAST`)
  return rows.rows
}

async function saveVideoEmbedding (videoID, embedding, hash, model) {
  // A video gone meanwhile (its channel was unset) is simply not there to update.
  await pool.query(
    'UPDATE youtube_videos SET embedding = $2, embedding_hash = $3, embedding_model_id = $4 WHERE video_id = $1',
    [videoID, toVectorLiteral(embedding), hash, await modelId(model)])
}

// Whether any video of the bot's channels has an embedding made by `model` (the channels are the
// same for every server; guildID is kept for the callers).
async function hasVideoEmbeddings (guildID, model) {
  const rows = await pool.query(
    'SELECT 1 FROM youtube_videos WHERE embedding_model_id = $1 AND embedding IS NOT NULL LIMIT 1',
    [await modelId(model)])
  return rows.rows.length !== 0
}

// { video_id: score } for the videos of the bot's channels that have an embedding made by `model`,
// score the cosine similarity to the vector `query`. The channels have at most a few thousand
// videos each, so all are scored.
async function videoScores (guildID, query, model) {
  const rows = await pool.query(
    'SELECT video_id, 1 - (embedding <=> $2::halfvec) AS score FROM youtube_videos WHERE embedding_model_id = $1 AND embedding IS NOT NULL',
    [await modelId(model), toVectorLiteral(query)])
  return Object.fromEntries(rows.rows.map(r => [r.video_id, Number(r.score)]))
}

module.exports = { noteEmbeddingBatch, saveEmbeddingBatch, runningEmbeddingBatches, deleteEmbeddingBatch, pendingMessages, saveMessageEmbeddings, embeddedMessagesAfter, dropMessageEmbeddings, resetStaleMessageEmbeddings, invalidateMessage, nearestMessages, getMessages, videosForEmbedding, saveVideoEmbedding, hasVideoEmbeddings, videoScores, modelId }
