// Embeddings of stored messages and YouTube videos, for searching by meaning.
//
// A message's embedding goes with its message: the foreign key deletes it when the message is deleted for any reason (retention,
// /clearmydata, the bot leaving), and an edit drops it to be made again. messages.embedded marks
// what has been handled, so finding new messages uses a small partial index, not a table scan.
// Videos have one vector each.
const pool = require('../../clients/postgres')

// Newest messages not handled yet: [{ id, guild_id, channel_id, ts, content }].
async function pendingMessages (limit) {
  const rows = await pool.query(
    'SELECT id, guild_id, channel_id, ts, content FROM messages WHERE NOT embedded ORDER BY ts DESC LIMIT $1',
    [limit])
  return rows.rows
}

// Stores [{ id, embedding, model }] and marks `handledIds` (which also covers messages that get no
// embedding, such as empty ones or ones from before channels were recorded).
async function saveMessageEmbeddings (rows, handledIds) {
  for (const r of rows) {
    // The message may have been deleted meanwhile; its embedding is then not wanted either.
    await pool.query(
      `INSERT INTO message_embeddings (message_id, embedding, model)
       SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM messages WHERE id = $1)
       ON CONFLICT (message_id) DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model`,
      [r.id, r.embedding, r.model])
  }
  if (handledIds.length) await pool.query('UPDATE messages SET embedded = true WHERE id = ANY($1)', [handledIds])
}

// Drops up to `limit` message embeddings made by another model and marks their messages to be
// embedded again. Resolves to how many were dropped.
async function resetStaleMessageEmbeddings (model, limit) {
  const result = await pool.query(
    `WITH stale AS (
       DELETE FROM message_embeddings WHERE message_id IN (SELECT message_id FROM message_embeddings WHERE model <> $1 LIMIT $2)
       RETURNING message_id
     )
     UPDATE messages SET embedded = false WHERE id IN (SELECT message_id FROM stale)`,
    [model, limit])
  return result.rowCount || 0
}

// An edited message is embedded again.
async function invalidateMessage (messageID) {
  await pool.query('DELETE FROM message_embeddings WHERE message_id = $1', [messageID])
  await pool.query('UPDATE messages SET embedded = false WHERE id = $1', [messageID])
}

// The stored message embeddings of a server in `channelIDs` made by `model`, newest first, `pageSize` at a time:
// an async iterator of [{ message_id, channel_id, ts, embedding }] pages,
// stopping after `max` rows.
async function * messageEmbeddingPages (guildID, channelIDs, { model, pageSize = 5000, max = 50000 } = {}) {
  let before = null
  let read = 0
  while (read < max) {
    const rows = (await pool.query(
      `SELECT e.message_id, m.channel_id, m.ts, e.embedding FROM message_embeddings e
       JOIN messages m ON m.id = e.message_id
       WHERE m.guild_id = $1 AND m.channel_id = ANY($2) AND e.model = $5 AND ($3::timestamptz IS NULL OR m.ts < $3)
       ORDER BY m.ts DESC LIMIT $4`,
      [guildID, channelIDs, before, Math.min(pageSize, max - read), model])).rows
    if (rows.length === 0) return
    read += rows.length
    before = rows[rows.length - 1].ts
    yield rows
  }
}

// Messages by ID: [{ id, author_id, channel_id, ts, content }].
async function getMessages (ids) {
  if (ids.length === 0) return []
  const rows = await pool.query('SELECT id, author_id, channel_id, ts, content FROM messages WHERE id = ANY($1)', [ids])
  return rows.rows
}

// Every stored video with what its embedding is made from: [{ video_id, title, description,
// summary, text_hash }].
async function videosForEmbedding () {
  const rows = await pool.query(
    `SELECT v.video_id, v.title, v.description, s.summary, e.text_hash FROM youtube_videos v
     LEFT JOIN youtube_summaries s ON s.video_id = v.video_id
     LEFT JOIN youtube_video_embeddings e ON e.video_id = v.video_id`)
  return rows.rows
}

async function saveVideoEmbedding (videoID, embedding, hash, model) {
  // The video may have gone meanwhile (its channel was unset).
  await pool.query(
    `INSERT INTO youtube_video_embeddings (video_id, embedding, text_hash, model)
     SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM youtube_videos WHERE video_id = $1)
     ON CONFLICT (video_id) DO UPDATE SET embedding = $2, text_hash = $3, model = $4`,
    [videoID, embedding, hash, model])
}

// { video_id: embedding } for the videos of a server's channel that have one made by `model`.
async function videoEmbeddings (guildID, model) {
  const rows = await pool.query(
    `SELECT e.video_id, e.embedding FROM youtube_video_embeddings e
     JOIN youtube_videos v ON v.video_id = e.video_id
     JOIN guild_youtube g ON g.channel_id = v.channel_id
     WHERE g.guild_id = $1 AND e.model = $2`,
    [guildID, model])
  return Object.fromEntries(rows.rows.map(r => [r.video_id, r.embedding]))
}

module.exports = { pendingMessages, saveMessageEmbeddings, resetStaleMessageEmbeddings, invalidateMessage, messageEmbeddingPages, getMessages, videosForEmbedding, saveVideoEmbedding, videoEmbeddings }
