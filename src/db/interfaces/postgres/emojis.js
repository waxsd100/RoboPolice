// The described custom emojis of each server (migrations/011_guild_emojis.sql).
const pool = require('../../clients/postgres')
const { toVectorLiteral } = require('../../../bot/utils/embeddings')

// Makes the stored emojis of the server match `emojis` ([{ id, name, animated }]): adds new ones,
// renames, and deletes those gone.
async function syncEmojis (guildID, emojis) {
  for (const e of emojis) {
    await pool.query(
      `INSERT INTO guild_emojis (emoji_id, guild_id, name, animated) VALUES ($1, $2, $3, $4)
       ON CONFLICT (emoji_id) DO UPDATE SET name = $3, animated = $4, updated_at = now()`,
      [e.id, guildID, e.name, !!e.animated])
  }
  await pool.query('DELETE FROM guild_emojis WHERE guild_id = $1 AND NOT (emoji_id = ANY($2))', [guildID, emojis.map(e => e.id)])
}

// Emojis of the server with no description for their current name, or described with other
// knowledge of the characters (contextHash): [{ emoji_id, name, animated }].
async function emojisToDescribe (guildID, limit, contextHash = null) {
  const rows = await pool.query(
    `SELECT emoji_id, name, animated FROM guild_emojis
     WHERE guild_id = $1 AND (description IS NULL OR described_name IS DISTINCT FROM name OR context_hash IS DISTINCT FROM $3)
     ORDER BY emoji_id LIMIT $2`,
    [guildID, limit, contextHash])
  return rows.rows
}

// Described emojis whose embedding is missing or was made by another model: [{ emoji_id, name, description }].
async function emojisToEmbed (guildID, model, limit) {
  const rows = await pool.query(
    `SELECT emoji_id, name, description FROM guild_emojis
     WHERE guild_id = $1 AND description IS NOT NULL AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $2::embedding_model)
     ORDER BY emoji_id LIMIT $3`,
    [guildID, model, limit])
  return rows.rows
}

async function saveDescription (emojiID, name, description, contextHash = null) {
  // A new description needs a new embedding.
  await pool.query(
    'UPDATE guild_emojis SET description = $2, described_name = $3, context_hash = $4, embedding = NULL, embedding_model = NULL, updated_at = now() WHERE emoji_id = $1',
    [emojiID, description, name, contextHash])
}

async function saveEmbedding (emojiID, embedding, model) {
  await pool.query(
    'UPDATE guild_emojis SET embedding = $2, embedding_model = $3 WHERE emoji_id = $1',
    [emojiID, toVectorLiteral(embedding), model])
}

const guildIDList = guildID => (Array.isArray(guildID) ? guildID : [guildID]).filter(Boolean)

// Stored usable emojis of the server(s): [{ id, guild_id, name, animated }].
async function listEmojis (guildID) {
  const ids = guildIDList(guildID)
  if (!ids.length) return []
  const rows = await pool.query(
    'SELECT emoji_id AS id, guild_id, name, animated FROM guild_emojis WHERE guild_id = ANY($1) ORDER BY emoji_id',
    [ids])
  return rows.rows
}

// { emoji_id: description } for the server(s)' described emojis.
async function descriptions (guildID) {
  const ids = guildIDList(guildID)
  if (!ids.length) return {}
  const rows = await pool.query('SELECT emoji_id, description FROM guild_emojis WHERE guild_id = ANY($1) AND description IS NOT NULL', [ids])
  return Object.fromEntries(rows.rows.map(r => [r.emoji_id, r.description]))
}

// IDs of the server(s)' emojis closest in meaning to the vector `query`, best first.
async function nearestEmojis (guildID, query, model, limit) {
  const ids = guildIDList(guildID)
  if (!ids.length) return []
  const rows = await pool.query(
    `SELECT emoji_id FROM guild_emojis WHERE guild_id = ANY($1) AND embedding_model = $2 AND embedding IS NOT NULL
     ORDER BY embedding <=> $3::halfvec LIMIT $4`,
    [ids, model, toVectorLiteral(query), limit])
  return rows.rows.map(r => r.emoji_id)
}

module.exports = { syncEmojis, emojisToDescribe, emojisToEmbed, saveDescription, saveEmbedding, listEmojis, descriptions, nearestEmojis }
