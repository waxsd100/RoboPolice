const pool = require('../../clients/postgres')
const { removeMessage } = require('../../messageBatcher')

// Everything stored for the server goes with its row: settings, messages, YouTube.
exports.deleteGuild = async function (guildID) {
  return await pool.query('DELETE FROM guilds WHERE id=$1', [guildID])
}

// Back to the settings of a new server, keeping its stored messages and YouTube data.
exports.resetGuild = async function (guildID) {
  await pool.query('DELETE FROM guild_event_logs WHERE guild_id = $1', [guildID])
  await pool.query('DELETE FROM guild_ignored_channels WHERE guild_id = $1', [guildID])
  await pool.query('DELETE FROM guild_disabled_events WHERE guild_id = $1', [guildID])
  await pool.query('UPDATE guilds SET log_bots = false WHERE id = $1', [guildID])
}

// Deletes the stored message wherever it is: in Postgres, or still in the in-memory batch (where
// it would otherwise be written later and stay searchable after being deleted).
exports.deleteMessage = async function (messageID) {
  removeMessage(messageID)
  return await pool.query('DELETE FROM messages WHERE id=$1', [messageID])
}
