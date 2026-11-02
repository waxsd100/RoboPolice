// How the mention assistant replies in each server: how long (migrations/025_reply_length.sql,
// /replylength) and whether it speaks as the streamer (026_streamer_persona.sql, /persona).
const pool = require('../../clients/postgres')

// { replyLength: 'long' | 'normal' | 'short' | null, streamerPersona: boolean } for the server.
async function getReplySettings (guildID) {
  const rows = await pool.query('SELECT reply_length, streamer_persona FROM guilds WHERE id = $1', [guildID])
  const row = rows.rows[0]
  return { replyLength: row?.reply_length || null, streamerPersona: row ? row.streamer_persona !== false : true }
}

async function getReplyLength (guildID) {
  return (await getReplySettings(guildID)).replyLength
}

// Makes the guild's row if there is none yet.
async function ensureGuild (guildID) {
  await require('./read').getGuild(guildID)
}

async function setReplyLength (guildID, length) {
  await ensureGuild(guildID)
  await pool.query('UPDATE guilds SET reply_length = $2 WHERE id = $1', [guildID, length])
}

async function setStreamerPersona (guildID, enabled) {
  await ensureGuild(guildID)
  await pool.query('UPDATE guilds SET streamer_persona = $2 WHERE id = $1', [guildID, enabled])
}

module.exports = { getReplySettings, getReplyLength, setReplyLength, setStreamerPersona }
