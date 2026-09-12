const Eris = require('eris')
const { getAuthorField } = require('../utils/embeds.js')
const { LEGAL_LINKS } = require('../utils/constants.js')

module.exports = {
  name: 'clearmydata',
  func: async interaction => {
    interaction.createMessage({
      embeds: [{
        title: 'Action needed:',
        description: `To request deletion of your data (messages), join the [support server](${process.env.DISCORD_SUPPORT_SERVER}) and contact the staff with your user ID. Remember: all stored messages are encrypted at rest and are automatically removed from the database after ${process.env.MESSAGE_HISTORY_DAYS} days regardless of this request.\n\nSee the [Privacy Policy](${LEGAL_LINKS.PRIVACY_POLICY}) for exactly what is stored.`,
        color: 16711680,
        timestamp: new Date(),
        footer: {
          icon_url: global.bot.user.avatarURL,
          text: `${global.bot.user.username}#${global.bot.user.discriminator}`
        },
        author: getAuthorField(interaction.member.user),
        fields: []
      }],
      flags: Eris.Constants.MessageFlags.EPHEMERAL
    }).catch(() => { })
  }
}
