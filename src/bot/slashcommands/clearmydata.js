const Eris = require('eris')
const { getAuthorField } = require('../utils/embeds.js')
const { LEGAL_LINKS } = require('../utils/constants.js')

module.exports = {
  name: 'clearmydata',
  func: async interaction => {
    interaction.createMessage({
      embeds: [{
        title: '対応が必要です',
        description: `保存データ（メッセージ）の削除をご希望の場合は、[サポートサーバー](${process.env.DISCORD_SUPPORT_SERVER}) に参加し、ご自身のユーザーIDを添えてスタッフへご連絡ください。保存されたメッセージは暗号化されており、この請求の有無にかかわらず ${process.env.MESSAGE_HISTORY_DAYS} 日で自動的に削除されます。\n\n何が保存されているかは[プライバシーポリシー](${LEGAL_LINKS.PRIVACY_POLICY})をご覧ください。`,
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
