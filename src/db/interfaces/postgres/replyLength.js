// The length of the mention assistant's replies, per server (migrations/025_reply_length.sql).
const pool = require('../../clients/postgres')

// The server's setting, or null when it has none.
async function getReplyLength (guildID) {
  const rows = await pool.query('SELECT reply_length FROM guilds WHERE id = $1', [guildID])
  return rows.rows[0]?.reply_length || null
}

async function setReplyLength (guildID, length) {
  await require('./read').getGuild(guildID) // makes the guild's row if there is none yet
  await pool.query('UPDATE guilds SET reply_length = $2 WHERE id = $1', [guildID, length])
}

module.exports = { getReplyLength, setReplyLength }
