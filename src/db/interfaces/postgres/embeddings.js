// Embeddings of stored messages and YouTube videos, for searching by meaning.
//
// A message's embedding goes with its message: the foreign key deletes it when the message is deleted for any reason (retention,
// /clearmydata, the bot leaving), and an edit drops it to be made again. messages.embedded marks
// what has been handled, so finding new messages uses a small partial index, not a table scan.
// Videos have one vector each.
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

// Messages not handled yet, those of the owner's servers first, then newest first:
// [{ id, guild_id, channel_id, ts, content }].
async function pendingMessages (limit) {
  const rows = await pool.query(
    'SELECT id, guild_id, channel_id, ts, content FROM messages WHERE NOT embedded ORDER BY (guild_id = ANY($2)) DESC NULLS LAST, ts DESC LIMIT $1',
    [limit, ownerGuildIDs()])
  return rows.rows
}

// Stores [{ id, embedding (an Int8Array from embed()), model }] and marks `handledIds` (which also covers messages that get no
// embedding, such as empty ones or ones from before channels were recorded).
async function saveMessageEmbeddings (rows, handledIds) {
  for (const r of rows) {
    // The message may have been deleted meanwhile; its embedding is then not wanted either.
    await pool.query(
      `INSERT INTO message_embeddings (message_id, embedding, model_id)
       SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM messages WHERE id = $1)
       ON CONFLICT (message_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_id = EXCLUDED.model_id`,
      [r.id, toVectorLiteral(r.embedding), await modelId(r.model)])
  }
  if (handledIds.length) await pool.query('UPDATE messages SET embedded = true WHERE id = ANY($1)', [handledIds])
}

// Drops up to `limit` message embeddings made by another model and marks their messages to be
// embedded again. Resolves to how many were dropped.
async function resetStaleMessageEmbeddings (model, limit) {
  const result = await pool.query(
    `WITH stale AS (
       DELETE FROM message_embeddings WHERE message_id IN (SELECT message_id FROM message_embeddings WHERE model_id <> $1 LIMIT $2)
       RETURNING message_id
     )
     UPDATE messages SET embedded = false WHERE id IN (SELECT message_id FROM stale)`,
    [await modelId(model), limit])
  return result.rowCount || 0
}

// An edited message is embedded again.
async function invalidateMessage (messageID) {
  await pool.query('DELETE FROM message_embeddings WHERE message_id = $1', [messageID])
  await pool.query('UPDATE messages SET embedded = false WHERE id = $1', [messageID])
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
      `SELECT e.message_id, 1 - (e.embedding <=> $4::halfvec) AS score FROM message_embeddings e
       JOIN messages m ON m.id = e.message_id
       WHERE m.guild_id = $1 AND m.channel_id = ANY($2) AND e.model_id = $3
       ORDER BY e.embedding <=> $4::halfvec LIMIT $5`,
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
    `SELECT v.video_id, v.title, v.description, s.summary, e.text_hash FROM youtube_videos v
     LEFT JOIN youtube_summaries s ON s.video_id = v.video_id
     LEFT JOIN youtube_video_embeddings e ON e.video_id = v.video_id
     ORDER BY v.published_at DESC NULLS LAST`)
  return rows.rows
}

async function saveVideoEmbedding (videoID, embedding, hash, model) {
  // The video may have gone meanwhile (its channel was unset).
  await pool.query(
    `INSERT INTO youtube_video_embeddings (video_id, embedding, text_hash, model_id)
     SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM youtube_videos WHERE video_id = $1)
     ON CONFLICT (video_id) DO UPDATE SET embedding = $2, text_hash = $3, model_id = $4`,
    [videoID, toVectorLiteral(embedding), hash, await modelId(model)])
}

// Whether any video of the bot's channels has an embedding made by `model` (the channels are the
// same for every server; guildID is kept for the callers).
async function hasVideoEmbeddings (guildID, model) {
  const rows = await pool.query(
    'SELECT 1 FROM youtube_video_embeddings WHERE model_id = $1 LIMIT 1',
    [await modelId(model)])
  return rows.rows.length !== 0
}

// { video_id: score } for the videos of the bot's channels that have an embedding made by `model`,
// score the cosine similarity to the vector `query`. The channels have at most a few thousand
// videos each, so all are scored.
async function videoScores (guildID, query, model) {
  const rows = await pool.query(
    'SELECT video_id, 1 - (embedding <=> $2::halfvec) AS score FROM youtube_video_embeddings WHERE model_id = $1',
    [await modelId(model), toVectorLiteral(query)])
  return Object.fromEntries(rows.rows.map(r => [r.video_id, Number(r.score)]))
}

module.exports = { pendingMessages, saveMessageEmbeddings, resetStaleMessageEmbeddings, invalidateMessage, nearestMessages, getMessages, videosForEmbedding, saveVideoEmbedding, hasVideoEmbeddings, videoScores, modelId }
