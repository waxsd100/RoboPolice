const pool = require('../../clients/postgres')
const { removeMessage } = require('../../messageBatcher')

exports.deleteGuild = async function (guildID) {
  return await pool.query('DELETE FROM guilds WHERE id=$1', [guildID])
}

// Deletes the stored message wherever it is: in Postgres, or still in the in-memory batch (where
// it would otherwise be written later and stay searchable after being deleted).
exports.deleteMessage = async function (messageID) {
  removeMessage(messageID)
  return await pool.query('DELETE FROM messages WHERE id=$1', [messageID])
}
