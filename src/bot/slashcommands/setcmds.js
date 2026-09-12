const path = require('path')

module.exports = {
  name: 'setcmds',
  type: 'creator',
  func: async interaction => {
    if (require.cache[path.resolve('src', 'bot', 'utils', 'slashcommandconstants.js')]) {
      delete require.cache[path.resolve('src', 'bot', 'utils', 'slashcommandconstants.js')]
    }
    const { developerCommands, commands } = require('../utils/slashcommandconstants')
    try {
        if (interaction.data?.options?.find(o => o.name === 'scope')?.value === 'guild') {
          await global.bot.bulkEditGuildCommands(interaction.channel.guild.id, [...commands, ...developerCommands])
          interaction.createMessage(`このサーバーに ${[...commands, ...developerCommands].length} 件のスラッシュコマンドを登録しました`)
          global.logger.info(`Guild set ${[...commands, ...developerCommands].length} slash commands successfully`)
        } else if (interaction.data?.options?.find(o => o.name === 'scope')?.value === 'global') {
          await global.bot.bulkEditCommands(commands)
          interaction.createMessage(`${commands.length} 件のスラッシュコマンドをグローバルに登録しました`)
          global.logger.info(`Globally set ${commands.length} slash commands successfully`)
        } else {
          interaction.createMessage('使い方が正しくありません。scope には guild か global を指定してください。')
        }
      } catch (e) {
        global.logger.error('Error setting guild slash commands', e)
        interaction.createMessage(`スラッシュコマンドの登録に失敗しました:\n${e?.message}`)
      }
  }
}
