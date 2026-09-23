const commandHandler = require('../modules/commandhandler')
const cacheMessage = require('../../db/interfaces/postgres/create').cacheMessage
const cacheGuild = require('../utils/cacheGuild')

module.exports = {
  name: 'messageCreate',
  type: 'on',
  handle: async message => {
    if (message.type === 23 || message.type === 24 || message.author.bot || !message.member) return // do not log automod actions
    await commandHandler(message)
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
