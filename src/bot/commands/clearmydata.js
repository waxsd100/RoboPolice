const { LEGAL_LINKS } = require('../utils/constants.js')
module.exports = {
  func: async message => {
    await message.channel.createMessage({
      embeds: [{
        title: 'Action needed:',
        description: `To request deletion of your data (messages), join the [support server](${process.env.DISCORD_SUPPORT_SERVER}) and contact the staff with your user ID. Stored messages are encrypted at rest and are automatically deleted after ${process.env.MESSAGE_HISTORY_DAYS} days regardless of this request.\n\nSee the [Privacy Policy](${LEGAL_LINKS.PRIVACY_POLICY}) for exactly what is stored.`,
        color: 16711680,
        timestamp: new Date(),
        footer: {
          icon_url: global.bot.user.avatarURL,
          text: `${global.bot.user.username}#${global.bot.user.discriminator}`
        },
        author: {
          name: `${message.author.username}#${message.author.discriminator}`,
          icon_url: message.author.avatarURL
        },
        fields: []
      }]
    })
  },
  name: 'clearmydata',
  quickHelp: `Provides the information needed to clear your data from the bot. Your stored messages are automatically deleted after ${process.env.MESSAGE_HISTORY_DAYS} days regardless of using this command.`,
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}clearmydata\``,
  type: 'any',
  category: 'Utility'
}
