// What a server is like (migrations/022_server_lore.sql, written by serverLore.js): knowledge taken
// out of its stored messages, one chunk per channel and week, and how its members talk.
const pool = require('../../clients/postgres')
const { toVectorLiteral } = require('../../../bot/utils/embeddings')
const { modelId } = require('./embeddings')

// The stored messages of a channel since `since`, oldest first: [{ author_id, ts, content }].
async function channelMessages (guildID, channelID, since) {
  const rows = await pool.query(
    `SELECT author_id, ts, content FROM messages
     WHERE guild_id = $1 AND channel_id = $2 AND ts >= $3 AND content IS NOT NULL AND content <> '' AND content <> 'None'
     ORDER BY ts`,
    [guildID, channelID, since])
  return rows.rows
}

// { 'channelID|YYYY-MM-DD': text_hash } of the chunks taken out for the server.
async function chunkHashes (guildID) {
  const rows = await pool.query("SELECT channel_id, to_char(week, 'YYYY-MM-DD') AS week, text_hash FROM guild_lore_chunks WHERE guild_id = $1", [guildID])
  return Object.fromEntries(rows.rows.map(r => [`${r.channel_id}|${r.week}`, r.text_hash]))
}

// Replaces what was taken out of a chunk: [{ kind, name, content }]. Pieces of knowledge that did
// not change keep their embedding.
async function saveChunk (guildID, channelID, week, textHash, facts) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO guild_lore_chunks (guild_id, channel_id, week, text_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, channel_id, week) DO UPDATE SET text_hash = $4, extracted_at = now()`,
      [guildID, channelID, week, textHash])
    const prev = (await client.query(
      'SELECT kind, name, content, embedding::text AS embedding, model_id FROM guild_lore_facts WHERE guild_id = $1 AND channel_id = $2 AND week = $3',
      [guildID, channelID, week])).rows
    const keyOf = f => `${f.kind}\n${f.name}\n${f.content}`
    const byKey = new Map(prev.filter(r => r.embedding).map(r => [keyOf(r), r]))
    await client.query('DELETE FROM guild_lore_facts WHERE guild_id = $1 AND channel_id = $2 AND week = $3', [guildID, channelID, week])
    for (const f of facts) {
      const kept = byKey.get(keyOf(f))
      await client.query(
        'INSERT INTO guild_lore_facts (guild_id, channel_id, week, kind, name, content, embedding, model_id) VALUES ($1, $2, $3, $4, $5, $6, $7::halfvec, $8)',
        [guildID, channelID, week, f.kind, f.name, f.content, kept?.embedding || null, kept?.model_id || null])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// Deletes the server's chunks (and their knowledge) other than `keys` ('channelID|YYYY-MM-DD').
// Resolves to how many went.
async function deleteChunksExcept (guildID, keys) {
  const result = await pool.query(
    "DELETE FROM guild_lore_chunks WHERE guild_id = $1 AND NOT (channel_id || '|' || to_char(week, 'YYYY-MM-DD') = ANY($2))",
    [guildID, keys])
  return result.rowCount || 0
}

// Knowledge with no embedding by `model`: [{ id, kind, name, content }].
async function factsToEmbed (model, limit) {
  const rows = await pool.query(
    `SELECT id, kind, name, content FROM guild_lore_facts
     WHERE embedding IS NULL OR model_id IS DISTINCT FROM $1 ORDER BY id LIMIT $2`,
    [await modelId(model), limit])
  return rows.rows
}

async function saveFactEmbedding (id, embedding, model) {
  await pool.query('UPDATE guild_lore_facts SET embedding = $2, model_id = $3 WHERE id = $1', [id, toVectorLiteral(embedding), await modelId(model)])
}

// The server's `limit` pieces of knowledge closest in meaning to the vector `query`:
// [{ kind, name, content, week, score }].
async function nearestFacts (guildID, query, model, limit) {
  const rows = await pool.query(
    `SELECT kind, name, content, to_char(week, 'YYYY-MM-DD') AS week, 1 - (embedding <=> $2::halfvec) AS score
     FROM guild_lore_facts WHERE guild_id = $1 AND model_id = $3 AND embedding IS NOT NULL
     ORDER BY embedding <=> $2::halfvec LIMIT $4`,
    [guildID, toVectorLiteral(query), await modelId(model), limit])
  return rows.rows.map(r => ({ ...r, score: Number(r.score) }))
}

async function hasFacts (guildID) {
  const rows = await pool.query('SELECT 1 FROM guild_lore_facts WHERE guild_id = $1 AND embedding IS NOT NULL LIMIT 1', [guildID])
  return rows.rows.length !== 0
}

// { style, source_hash, updated_at } of the server, or null.
async function getStyle (guildID) {
  const rows = await pool.query('SELECT style, source_hash, updated_at FROM guild_lore_style WHERE guild_id = $1', [guildID])
  return rows.rows[0] || null
}

async function saveStyle (guildID, style, sourceHash) {
  await pool.query(
    `INSERT INTO guild_lore_style (guild_id, style, source_hash) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id) DO UPDATE SET style = $2, source_hash = $3, updated_at = now()`,
    [guildID, style, sourceHash])
}

async function deleteStyle (guildID) {
  await pool.query('DELETE FROM guild_lore_style WHERE guild_id = $1', [guildID])
}

// A member's stored messages in `channelIDs`, newest first: [{ channel_id, ts, content }]. Read when
// someone asks about the member; nothing is kept from it.
async function memberMessages (guildID, authorID, channelIDs, limit) {
  const rows = await pool.query(
    `SELECT channel_id, ts, content FROM messages
     WHERE guild_id = $1 AND author_id = $2 AND channel_id = ANY($3) AND content IS NOT NULL AND content <> '' AND content <> 'None'
     ORDER BY ts DESC LIMIT $4`,
    [guildID, authorID, channelIDs, limit])
  return rows.rows
}

module.exports = { channelMessages, chunkHashes, saveChunk, deleteChunksExcept, factsToEmbed, saveFactEmbedding, nearestFacts, hasFacts, getStyle, saveStyle, deleteStyle, memberMessages }
