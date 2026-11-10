const path = require('path')

module.exports = {
  func: async (message, suffix) => {
    if (require.cache[path.resolve('src', 'bot', 'utils', 'slashcommandconstants.js')]) {
      delete require.cache[path.resolve('src', 'bot', 'utils', 'slashcommandconstants.js')]
    }
    const { developerCommands, commands } = require('../utils/slashcommandconstants')
    try {
      if (suffix === 'guild') {
        const guildCommands = [...commands, ...developerCommands]
        await global.bot.bulkEditGuildCommands(message.channel.guild.id, guildCommands)
        message.channel.createMessage({ content: 'OK set guild commands', messageReference: { messageID: message.id } })
        global.logger.info(`Guild set ${guildCommands.length} slash commands successfully`)
      } else if (suffix === 'global') {
        await global.bot.bulkEditCommands(commands)
        message.channel.createMessage({ content: 'OK set global commands', messageReference: { messageID: message.id } })
        global.logger.info(`Globally set ${commands.length} slash commands successfully`)
      } else {
        message.channel.createMessage({ content: 'Incorrect usage, options are guild or global.', messageReference: { messageID: message.id } })
      }
    } catch (e) {
      global.logger.error('Error setting guild slash commands', e)
      message.channel.createMessage({ content: 'Error setting slash commands', messageReference: { messageID: message.id } })
    }
  },
  name: 'setcmd',
  description: 'Bot owner debug command.',
  type: 'creator',
  hidden: true
}
