const send = require('../modules/webhooksender')
const { EMBED_COLORS } = require('../utils/constants')
const discordKnowledge = require('../modules/discordKnowledge')
const messageBatcher = require('../../db/messageBatcher')
const deleteDB = require('../../db/interfaces/postgres/delete')
const cacheGuild = require('../utils/cacheGuild')

module.exports = {
  name: 'messageDeleteBulk',
  type: 'on',
  handle: async messages => {
    if (!Array.isArray(messages) || messages.length === 0) return
    const ids = messages.map(m => m?.id).filter(Boolean)
    for (const id of ids) {
      discordKnowledge.onDelete(id).catch(e => global.logger.warn(`[DISCORD]: ${e.message}`))
    }

    const evict = messageBatcher.evictMessage || messageBatcher.removeMessage
    if (typeof evict === 'function') {
      for (const id of ids) evict(id)
    }
    if (ids.length > 0) {
      try {
        if (typeof deleteDB.deleteMessages === 'function') {
          await deleteDB.deleteMessages(ids)
        } else if (typeof deleteDB.deleteMessage === 'function') {
          await Promise.all(ids.map(id => deleteDB.deleteMessage(id)))
        }
      } catch (e) {
        global.logger?.warn?.(`[DB] Failed to bulk delete messages: ${e.message}`)
      }
    }

    // Eris populates this differently depending on whether the deleted messages were cached
    // (channel.guild.id) or arrived as raw gateway stubs (guildID/guildId).
    const guildID = messages[0]?.channel?.guild?.id || messages[0]?.guildID || messages[0]?.guildId
    if (!guildID) return

    let guildSettings = global.bot.guildSettingsCache?.[guildID]
    if (!guildSettings) {
      try {
        await cacheGuild(guildID)
        guildSettings = global.bot.guildSettingsCache?.[guildID]
      } catch (_) {}
    }
    const channelID = messages[0]?.channel?.id || messages[0]?.channelID || messages[0]?.channelId
    if (channelID && guildSettings?.isChannelIgnored?.(channelID)) return

    await send({
      guildID,
      eventName: 'messageDeleteBulk',
      embeds: [{
        description: `**${messages.length}** 件のメッセージが一括削除されました。`,
        color: EMBED_COLORS.YELLOW_ORANGE
      }]
    })
  }
}
