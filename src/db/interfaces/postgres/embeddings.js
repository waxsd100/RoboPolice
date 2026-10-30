// Embeddings of stored messages and YouTube videos, for searching by meaning.
//
// A message's embedding is encrypted like its content (it says much of what the message said) and
// goes with it: the foreign key deletes it when the message is deleted for any reason (retention,
// /clearmydata, the bot leaving), and an edit drops it to be made again. messages.embedded marks
// what has been handled, so finding new messages uses a small partial index, not a table scan.
const pool = require('../../clients/postgres')
const aes = require('../../aes')
const { ensureChannelColumns } = require('../../messageColumns')

const SCHEMA = [
  // A constant default is a catalog change only: no table rewrite.
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedded BOOLEAN NOT NULL DEFAULT false',
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_unembedded ON messages (ts DESC) WHERE NOT embedded',
  `CREATE TABLE IF NOT EXISTS message_embeddings (
    message_id TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    ts TIMESTAMPTZ,
    embedding TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS message_embeddings_guild_ts ON message_embeddings (guild_id, ts DESC)',
  // Videos are public data: their vectors are stored as they are.
  'ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS embedding TEXT',
  'ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS embedding_hash TEXT'
]

let ready = null
function ensureTables () {
  if (!ready) {
    ready = (async () => {
      await ensureChannelColumns()
      await require('./youtube').ensureTables()
      for (const sql of SCHEMA) await pool.query(sql)
    })().catch(e => {
      ready = null
      throw e
    })
  }
  return ready
}

// Newest messages not handled yet, decrypted: [{ id, guild_id, channel_id, ts, content }].
async function pendingMessages (limit) {
  await ensureTables()
  const rows = await pool.query(
    'SELECT id, guild_id, channel_id, ts, content FROM messages WHERE NOT embedded ORDER BY ts DESC LIMIT $1',
    [limit])
  return rows.rows.map(r => ({ ...r, content: aes.decrypt(r.content) }))
}

// Stores [{ id, guild_id, channel_id, ts, embedding }] and marks `handledIds` (which also covers
// messages that get no embedding, such as empty ones or ones from before channels were recorded).
async function saveMessageEmbeddings (rows, handledIds) {
  await ensureTables()
  for (const r of rows) {
    // The message may have been deleted meanwhile; its embedding is then not wanted either.
    await pool.query(
      `INSERT INTO message_embeddings (message_id, guild_id, channel_id, ts, embedding)
       SELECT $1, $2, $3, $4, $5 WHERE EXISTS (SELECT 1 FROM messages WHERE id = $1)
       ON CONFLICT (message_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [r.id, r.guild_id, r.channel_id, r.ts, aes.encrypt(r.embedding)])
  }
  if (handledIds.length) await pool.query('UPDATE messages SET embedded = true WHERE id = ANY($1)', [handledIds])
}

// An edited message is embedded again.
async function invalidateMessage (messageID) {
  await ensureTables()
  await pool.query('DELETE FROM message_embeddings WHERE message_id = $1', [messageID])
  await pool.query('UPDATE messages SET embedded = false WHERE id = $1', [messageID])
}

// The stored message embeddings of a server in `channelIDs`, newest first, `pageSize` at a time:
// an async iterator of [{ message_id, channel_id, ts, embedding }] pages (embedding decrypted),
// stopping after `max` rows.
async function * messageEmbeddingPages (guildID, channelIDs, { pageSize = 5000, max = 50000 } = {}) {
  await ensureTables()
  let before = null
  let read = 0
  while (read < max) {
    const rows = (await pool.query(
      `SELECT message_id, channel_id, ts, embedding FROM message_embeddings
       WHERE guild_id = $1 AND channel_id = ANY($2) AND ($3::timestamptz IS NULL OR ts < $3)
       ORDER BY ts DESC LIMIT $4`,
      [guildID, channelIDs, before, Math.min(pageSize, max - read)])).rows
    if (rows.length === 0) return
    read += rows.length
    before = rows[rows.length - 1].ts
    yield rows.map(r => ({ ...r, embedding: aes.decrypt(r.embedding) }))
  }
}

// Decrypted messages by ID: [{ id, author_id, channel_id, ts, content }].
async function getMessages (ids) {
  if (ids.length === 0) return []
  const rows = await pool.query('SELECT id, author_id, channel_id, ts, content FROM messages WHERE id = ANY($1)', [ids])
  return rows.rows.map(r => ({ ...r, content: aes.decrypt(r.content) }))
}

// Every stored video with what its embedding is made from: [{ guild_id, video_id, title,
// description, summary, embedding_hash }].
async function videosForEmbedding () {
  await ensureTables()
  const rows = await pool.query(
    `SELECT v.guild_id, v.video_id, v.title, v.description, s.summary, v.embedding_hash FROM youtube_videos v
     LEFT JOIN youtube_summaries s ON s.guild_id = v.guild_id AND s.video_id = v.video_id`)
  return rows.rows
}

async function saveVideoEmbedding (guildID, videoID, embedding, hash) {
  await ensureTables()
  await pool.query('UPDATE youtube_videos SET embedding = $3, embedding_hash = $4 WHERE guild_id = $1 AND video_id = $2', [guildID, videoID, embedding, hash])
}

// { video_id: embedding } for a server's videos that have one.
async function videoEmbeddings (guildID) {
  await ensureTables()
  const rows = await pool.query('SELECT video_id, embedding FROM youtube_videos WHERE guild_id = $1 AND embedding IS NOT NULL', [guildID])
  return Object.fromEntries(rows.rows.map(r => [r.video_id, r.embedding]))
}

module.exports = { SCHEMA, ensureTables, pendingMessages, saveMessageEmbeddings, invalidateMessage, messageEmbeddingPages, getMessages, videosForEmbedding, saveVideoEmbedding, videoEmbeddings }
