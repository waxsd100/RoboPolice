const { LEGAL_LINKS } = require('../utils/constants.js')
module.exports = {
  func: async message => {
    await message.channel.createMessage({
      embeds: [{
        title: '対応が必要です',
        description: `保存データ（メッセージ）の削除をご希望の場合は、[サポートサーバー](${process.env.DISCORD_SUPPORT_SERVER}) に参加し、ご自身のユーザーIDを添えてスタッフへご連絡ください。保存されたメッセージは暗号化されており、この請求の有無にかかわらず ${process.env.MESSAGE_HISTORY_DAYS} 日で自動的に削除されます。\n\n何が保存されているかは[プライバシーポリシー](${LEGAL_LINKS.PRIVACY_POLICY})をご覧ください。`,
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
  quickHelp: `保存データの削除請求方法を案内します。保存されたメッセージは、このコマンドの利用有無にかかわらず ${process.env.MESSAGE_HISTORY_DAYS} 日で自動的に削除されます。`,
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}clearmydata\``,
  type: 'any',
  category: 'Utility'
}
