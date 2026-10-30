const pool = require('../../clients/postgres')
const cacheGuild = require('../../../bot/utils/cacheGuild')
const batchHandler = require('../../messageBatcher')
const escape = require('markdown-escape')

async function createGuild (guild) {
  try {
    // Settings start empty: no event is logged, no channel ignored (see migrations/002_guild_settings.sql).
    await pool.query('INSERT INTO guilds (id, owner_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [guild.id, guild.ownerID])
    await cacheGuild(guild.id)
  } catch (e) {
    global.logger.warn(`Could not create the settings of ${guild.id}: ${e.message}`)
  }
}

// The form message content is stored in. messageUpdate compares against and
// writes back this exact form, so a stored row never mixes escaped and raw text.
function toStoredContent (content) {
  if (!content) return 'None'
  return escape(content.replace(/~/g, '\\~'), ['angle brackets'])
}

// Discord allows 10 embeds per message, and the logs show one image per embed.
const MAX_IMAGES = 10

async function cacheMessage (message) {
  const content = toStoredContent(message.content)
  // Image URLs in order, without repeats.
  const imageUrls = [...new Set(message.attachments.filter(a => a.content_type?.startsWith('image')).map(a => a.url))].slice(0, MAX_IMAGES)
  await batchHandler.addItem([message.id, message.author.id, content, imageUrls, new Date().toISOString(), message.channel.id, message.channel.guild?.id || null])
}

// The text as the user wrote it, from toStoredContent's form: markdown-escape put a backslash before
// each of * # / ( ) [ ] _ ` and ~ was escaped the same way; 'None' stands for an empty message.
function fromStoredContent (stored) {
  if (!stored || stored === 'None') return ''
  return stored.replace(/\\([*#/()[\]_`~])/g, '$1')
}

exports.cacheMessage = cacheMessage
exports.toStoredContent = toStoredContent
exports.fromStoredContent = fromStoredContent
exports.createGuild = createGuild
