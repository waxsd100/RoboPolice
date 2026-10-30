const pool = require('../../clients/postgres')
const createGuild = require('./create').createGuild
const aes = require('../../aes')
const { getChannelMessages } = require('../../messageBatcher')
const { ALL_EVENTS } = require('../../../bot/utils/constants')

// A server's settings in the shape GuildSettings takes: event_logs maps every event to its log
// channel ('' for none).
const GUILD_SETTINGS = `SELECT g.id, g.owner_id, g.log_bots,
  COALESCE((SELECT json_object_agg(e.event, e.channel_id) FROM guild_event_logs e WHERE e.guild_id = g.id), '{}') AS logged_events,
  COALESCE((SELECT array_agg(c.channel_id ORDER BY c.channel_id) FROM guild_ignored_channels c WHERE c.guild_id = g.id), '{}') AS ignored_channels,
  COALESCE((SELECT array_agg(d.event ORDER BY d.event) FROM guild_disabled_events d WHERE d.guild_id = g.id), '{}') AS disabled_events
  FROM guilds g`

function toSettings ({ logged_events: logged, ...row }) {
  return { ...row, event_logs: { ...Object.fromEntries(ALL_EVENTS.map(e => [e, ''])), ...logged } }
}

async function getAllGuilds () {
  const doc = await pool.query(GUILD_SETTINGS)
  return doc.rows.map(toSettings)
}

async function getGuild (guildID) {
  const doc = await pool.query(`${GUILD_SETTINGS} WHERE g.id = $1`, [guildID])
  if (doc.rows.length === 0) {
    if (global.bot.guilds.get(guildID)) {
      await createGuild(global.bot.guilds.get(guildID))
      return await getGuild(guildID)
    }
    return undefined
  }
  return toSettings(doc.rows[0])
}

// A stored message, decrypted, with its image URLs in order (attachment_urls), or null.
async function getMessageById (messageID) {
  const message = await pool.query('SELECT * FROM messages WHERE id=$1', [messageID])
  if (message.rows.length === 0) return null
  const attachments = await pool.query('SELECT url FROM message_attachments WHERE message_id = $1 ORDER BY position', [messageID])
  return {
    ...message.rows[0],
    content: aes.decrypt(message.rows[0].content),
    attachment_urls: attachments.rows.map(r => aes.decrypt(r.url))
  }
}

// A channel's stored messages, newest first: the ones still in the in-memory batch, then Postgres.
// Only text is returned; attachments stay encrypted where they are.
async function getChannelHistory (channelID, limit) {
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
