const Eris = require('eris')
const { getAuthorField } = require('../utils/embeds.js')
const { LEGAL_LINKS } = require('../utils/constants.js')

module.exports = {
  name: 'clearmydata',
  func: async interaction => {
    interaction.createMessage({
      embeds: [{
        title: 'Action needed:',
        description: `To request deletion of your data (messages), join the [support server](${process.env.DISCORD_SUPPORT_SERVER}) and contact the staff with your user ID. Stored messages are encrypted at rest, and we delete them on request.\n\nSee the [Privacy Policy](${LEGAL_LINKS.PRIVACY_POLICY}) for exactly what is stored and for how long.`,
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
