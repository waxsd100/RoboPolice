// The described custom emojis of each server (migrations/011_guild_emojis.sql).
const pool = require('../../clients/postgres')
const { toVectorLiteral } = require('../../../bot/utils/embeddings')
const { modelId } = require('./embeddings')

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

// Emojis of the server with no description for their current name: [{ emoji_id, name, animated }].
async function emojisToDescribe (guildID, limit) {
  const rows = await pool.query(
    `SELECT emoji_id, name, animated FROM guild_emojis
     WHERE guild_id = $1 AND (description IS NULL OR described_name IS DISTINCT FROM name)
     ORDER BY emoji_id LIMIT $2`,
    [guildID, limit])
  return rows.rows
}

// Described emojis whose embedding is missing or was made by another model: [{ emoji_id, name, description }].
async function emojisToEmbed (guildID, model, limit) {
  const rows = await pool.query(
    `SELECT emoji_id, name, description FROM guild_emojis
     WHERE guild_id = $1 AND description IS NOT NULL AND (embedding IS NULL OR model_id IS DISTINCT FROM $2)
     ORDER BY emoji_id LIMIT $3`,
    [guildID, await modelId(model), limit])
  return rows.rows
}

async function saveDescription (emojiID, name, description) {
  // A new description needs a new embedding.
  await pool.query(
    'UPDATE guild_emojis SET description = $2, described_name = $3, embedding = NULL, model_id = NULL, updated_at = now() WHERE emoji_id = $1',
    [emojiID, description, name])
}

async function saveEmbedding (emojiID, embedding, model) {
  await pool.query(
    'UPDATE guild_emojis SET embedding = $2, model_id = $3 WHERE emoji_id = $1',
    [emojiID, toVectorLiteral(embedding), await modelId(model)])
}

// { emoji_id: description } for the server's described emojis.
async function descriptions (guildID) {
  const rows = await pool.query('SELECT emoji_id, description FROM guild_emojis WHERE guild_id = $1 AND description IS NOT NULL', [guildID])
  return Object.fromEntries(rows.rows.map(r => [r.emoji_id, r.description]))
}

// IDs of the server's emojis closest in meaning to the vector `query`, best first.
async function nearestEmojis (guildID, query, model, limit) {
  const rows = await pool.query(
    `SELECT emoji_id FROM guild_emojis WHERE guild_id = $1 AND model_id = $2 AND embedding IS NOT NULL
     ORDER BY embedding <=> $3::halfvec LIMIT $4`,
    [guildID, await modelId(model), toVectorLiteral(query), limit])
  return rows.rows.map(r => r.emoji_id)
}

module.exports = { syncEmojis, emojisToDescribe, emojisToEmbed, saveDescription, saveEmbedding, descriptions, nearestEmojis }
