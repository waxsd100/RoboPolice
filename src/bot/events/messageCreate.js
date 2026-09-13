const commandHandler = require('../modules/commandhandler')
const cacheMessage = require('../../db/interfaces/postgres/create').cacheMessage
const cacheGuild = require('../utils/cacheGuild')

module.exports = {
  name: 'messageCreate',
  type: 'on',
  handle: async message => {
    if (message.type === 23 || message.type === 24 || message.author.bot || !message.member) return // do not log automod actions
    // 環境変数は文字列なので、素の truthy 判定では "false" でも有効になってしまう。
    // ただし従来は「何か入っていれば有効」だったため、明示的な無効値以外は有効のままにする。
    if (!['false', '0', 'no', 'off', '', 'undefined'].includes(String(process.env.ENABLE_TEXT_COMMANDS).toLowerCase())) {
      await commandHandler(message)
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
