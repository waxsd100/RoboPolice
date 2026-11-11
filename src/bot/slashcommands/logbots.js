const Eris = require('eris')
const { toggleLogBots } = require('../../db/interfaces/postgres/update')
const { EMBED_COLORS } = require('../utils/constants')
const { getEmbedFooter, getAuthorField } = require('../utils/embeds')
const { pick } = require('../utils/i18n')

module.exports = {
  name: 'logbots',
  botPerms: ['manageWebhooks', 'manageChannels'],
  userPerms: ['manageWebhooks', 'manageChannels'],
  func: async interaction => {
    const common = {
      thumbnail: { url: interaction.member.user.dynamicAvatarURL(null, 64) },
      author: getAuthorField(interaction.member.user),
      footer: getEmbedFooter(global.bot.user)
    }
    try {
      const isLoggingBots = await toggleLogBots(interaction.guildID)
      interaction.createMessage({
        embeds: [{
          description: isLoggingBots
            ? pick(interaction, { ja: 'BOT が送ったメッセージの編集・削除もログに __出す__ ようにしました。', en: 'Edits and deletions of bots\' messages are now __logged__.' })
            : pick(interaction, { ja: 'BOT が送ったメッセージの編集・削除はログに __出さない__ ようにしました。', en: 'Edits and deletions of bots\' messages are __no longer logged__.' }),
          color: EMBED_COLORS.GREEN,
          ...common
        }],
        flags: Eris.Constants.MessageFlags.EPHEMERAL
      }).catch(() => {})
    } catch (e) {
      global.logger.error(e)
      interaction.createMessage({
        embeds: [{
          title: pick(interaction, { ja: 'エラー', en: 'Error' }),
          description: pick(interaction, { ja: 'logbots を切り替えられませんでした。もう一度お試しください。', en: 'Could not change logbots. Please try again.' }),
          color: EMBED_COLORS.RED,
          ...common
        }],
        flags: Eris.Constants.MessageFlags.EPHEMERAL
      }).catch(() => {})
    }
  }
}
