const pool = require('../../clients/postgres')
const createGuild = require('./create').createGuild
const aes = require('../../aes')
const { ensureChannelColumns } = require('../../messageColumns')
const { getChannelMessages } = require('../../messageBatcher')

async function getAllGuilds () {
  const doc = await pool.query('SELECT * FROM guilds;')
  return doc.rows
}

async function getGuild (guildID) {
  const doc = await pool.query('SELECT * FROM guilds WHERE id=$1;', [guildID])
  if (doc.rows.length === 0) {
    if (global.bot.guilds.get(guildID)) {
      await createGuild(global.bot.guilds.get(guildID))
      return await getGuild(guildID)
    }
  }
  return doc.rows[0]
}

async function getMessageById (messageID) {
  let message = await pool.query('SELECT * FROM messages WHERE id=$1', [messageID])
  if (message.rows.length === 0) return null
  message = await decryptMessageDoc(message.rows[0])
  return message
}

async function decryptMessageDoc (message) {
  message.content = aes.decrypt(message.content)
  if (message.attachment_b64) message.attachment_b64 = aes.decrypt(message.attachment_b64)
  return message
}

// A channel's stored messages, newest first: the ones still in the in-memory batch, then Postgres.
// Only text is returned; attachments stay encrypted where they are.
async function getChannelHistory (channelID, limit) {
  await ensureChannelColumns()
  const pending = getChannelMessages(channelID)
  const stored = await pool.query(
    'SELECT id, author_id, content, ts FROM messages WHERE channel_id = $1 ORDER BY ts DESC LIMIT $2',
    [channelID, Math.max(limit - pending.length, 0)])
  return [...pending, ...stored.rows.map(row => ({ ...row, content: aes.decrypt(row.content) }))].slice(0, limit)
}

exports.getMessageById = getMessageById
exports.getChannelHistory = getChannelHistory
exports.getAllGuilds = getAllGuilds
exports.getGuild = getGuild
