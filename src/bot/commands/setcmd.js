const ERIS_CONSTANTS = require('eris').Constants

module.exports = {
  func: async (message, suffix) => {
    let { developerCommands, commands } = require('../utils/slashcommandconstants')
    if (process.env.DISABLE_INVITE_COMMANDS === 'true') {
      commands = commands.filter(c => c.name !== 'invite')
    }
    try {
      if (suffix === 'guild') {
        await global.bot.bulkEditGuildCommands(message.channel.guild.id, [...developerCommands, ...commands])
        message.channel.createMessage({ content: 'OK set guild commands', messageReference: { messageID: message.id } })
        global.logger.info(`Guild set ${commands.length} slash commands successfully`)
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
