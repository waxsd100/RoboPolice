const commandHandler = require('../modules/commandhandler')
const mentionEvent = require('../modules/mentionEvent')
const discordKnowledge = require('../modules/discordKnowledge')
const altDetector = require('../modules/altDetector')
const wickModeration = require('../modules/wickModeration')
const cacheMessage = require('../../db/interfaces/postgres/create').cacheMessage
const cacheGuild = require('../utils/cacheGuild')

module.exports = {
  name: 'messageCreate',
  type: 'on',
  handle: async message => {
    if (message.type === 23 || message.type === 24 || !message.author) return // do not log automod actions
    if (message.channel?.guild?.id && wickModeration.isWickMessage(message)) {
      wickModeration.onWickMessage(message).catch(e => global.logger.warn(`[WICK]: ${e.message}`))
    }
    if (!message.member) return
    if (!message.author.bot) {
      await commandHandler(message)
      mentionEvent.handle(message).catch(e => global.logger.error(e))
      discordKnowledge.onMessage(message).catch(e => global.logger.warn(`[DISCORD]: ${e.message}`))
      altDetector.onMessage(message).catch(e => global.logger.warn(`[ALT]: ${e.message}`))
    }
    if (message.author.id === global.bot.user.id) return // dump logs made by the bot
    let guildSettings = global.bot.guildSettingsCache[message.channel.guild.id]
    if (!guildSettings) {
      await cacheGuild(message.channel.guild.id)
      guildSettings = global.bot.guildSettingsCache[message.channel.guild.id]
    }
    if (!guildSettings) return
    // No delete/edit log channel here, so a stored row could never be read back. Don't store it.
    if (!guildSettings.needsMessageCache()) return
    if (!guildSettings.isChannelIgnored(message.channel.id)) {
      if (!guildSettings.isLogBots() && message.author.bot) return
      await cacheMessage(message)
    }
  }
}
