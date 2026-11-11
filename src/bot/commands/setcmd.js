const path = require('path')

module.exports = {
  func: async (message, suffix) => {
    if (require.cache[path.resolve('src', 'bot', 'utils', 'slashcommandconstants.js')]) {
      delete require.cache[path.resolve('src', 'bot', 'utils', 'slashcommandconstants.js')]
    }
    const { developerCommands, commands } = require('../utils/slashcommandconstants')
    const scope = String(suffix || '').trim().toLowerCase()
    try {
      if (scope === 'guild') {
        const guildCommands = [...commands, ...developerCommands]
        await global.bot.bulkEditGuildCommands(message.channel.guild.id, guildCommands)
        message.channel.createMessage({ content: `✅ このサーバーに ${guildCommands.length} 件のスラッシュコマンドを登録しました（すぐ反映されます）。`, messageReference: { messageID: message.id } })
        global.logger.info(`Guild set ${guildCommands.length} slash commands successfully`)
      } else if (scope === 'global') {
        await global.bot.bulkEditCommands(commands)
        message.channel.createMessage({ content: `✅ グローバルに ${commands.length} 件のスラッシュコマンドを登録しました。`, messageReference: { messageID: message.id } })
        global.logger.info(`Globally set ${commands.length} slash commands successfully`)
      } else {
        const prefix = process.env.GLOBAL_BOT_PREFIX || '%'
        message.channel.createMessage({ content: `使い方が正しくありません。\`${prefix}setcmd guild\`（このサーバーに即時登録）または \`${prefix}setcmd global\`（全サーバーに登録）を指定してください。`, messageReference: { messageID: message.id } })
      }
    } catch (e) {
      global.logger.error('Error setting guild slash commands', e)
      message.channel.createMessage({ content: '❌ スラッシュコマンドの登録に失敗しました。BOTに `applications.commands` スコープが付与されているか確認してください。', messageReference: { messageID: message.id } })
    }
  },
  name: 'setcmd',
  description: 'Bot owner debug command.',
  type: 'creator',
  hidden: true
}
