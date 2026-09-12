const { toggleLogBots } = require('../../db/interfaces/postgres/update')
const { EMBED_COLORS } = require('../utils/constants')
const { getEmbedFooter, getAuthorField } = require('../utils/embeds')

module.exports = {
  name: 'logbots',
  botPerms: ['manageWebhooks', 'manageChannels'],
  userPerms: ['manageWebhooks', 'manageChannels'],
  func: async interaction => {
    try {
      const isLoggingBots = await toggleLogBots(interaction.guildID)
      interaction.createMessage({
        embeds: [{
          description: `BOTが送信したメッセージの編集・削除ログを __${isLoggingBots ? '有効化' : '無効化'}__ しました。`,
          color: EMBED_COLORS.GREEN,
          thumbnail: {
            url: interaction.member.user.dynamicAvatarURL(null, 64)
          },
          author: getAuthorField(interaction.member.user),
          footer: getEmbedFooter(global.bot.user)
        }]
      }).catch(() => {})
    } catch (e) {
      global.logger.error(e)
      interaction.createMessage({
        embeds: [{
          title: 'エラー',
          description: 'logbots の切り替えに失敗しました。もう一度お試しください。',
          color: EMBED_COLORS.RED,
          thumbnail: {
            url: interaction.member.user.dynamicAvatarURL(null, 64)
          },
          author: getAuthorField(interaction.member.user),
          footer: getEmbedFooter(global.bot.user)
        }]
      }).catch(() => {})
    }
  }
}
