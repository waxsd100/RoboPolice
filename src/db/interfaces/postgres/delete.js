const pool = require('../../clients/postgres')
const { removeMessage } = require('../../messageBatcher')

// Everything stored for the server goes with its row: settings, messages, YouTube.
exports.deleteGuild = async function (guildID) {
  return await pool.query('DELETE FROM guilds WHERE id=$1', [guildID])
}

// Back to the settings of a new server, keeping its stored messages and YouTube data.
exports.resetGuild = async function (guildID) {
  await pool.query('DELETE FROM guild_event_logs WHERE guild_id = $1', [guildID])
  await pool.query('UPDATE discord_channels SET ignored = false WHERE guild_id = $1 AND ignored', [guildID])
  await pool.query(
    `DELETE FROM discord_channels c
     WHERE c.guild_id = $1 AND NOT c.ignored AND c.name IS NULL
       AND c.msg_backfill_at IS NULL AND c.post_backfill_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM discord_posts p WHERE p.channel_id = c.id)`,
    [guildID])
  await pool.query('UPDATE guilds SET log_bots = false WHERE id = $1', [guildID])
}

// Deletes the stored message wherever it is: in Postgres, or still in the in-memory batch (where
// it would otherwise be written later and stay searchable after being deleted).
exports.deleteMessage = async function (messageID) {
  removeMessage(messageID)
  await pool.query('DELETE FROM mention_logs WHERE message_id = $1 OR reply_message_id = $1', [messageID]).catch(() => {})
  return await pool.query('DELETE FROM messages WHERE id=$1', [messageID])
}

exports.deleteMessages = async function (ids) {
  if (!ids?.length) return
  for (const id of ids) removeMessage(id)
  await pool.query('DELETE FROM mention_logs WHERE message_id = ANY($1::text[]) OR reply_message_id = ANY($1::text[])', [ids]).catch(() => {})
  return await pool.query('DELETE FROM messages WHERE id = ANY($1::text[])', [ids])
}
