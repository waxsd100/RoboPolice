const Eris = require('eris')
const { EMBED_COLORS } = require('../utils/constants.js')
const { getEmbedFooter } = require('../utils/embeds')

module.exports = {
  name: 'invite',
  func: async interaction => {
    interaction.createMessage({
      embeds: [{
        title: '招待リンク',
        description: '用途別の招待リンクです。必要最小限の権限だけを付与できるよう（最小権限の原則）、目的ごとに分けてあります。\n\n招待したあとの設定方法は `/help guide: Usage` を参照してください。',
        color: EMBED_COLORS.PURPLED_BLUE,
        thumbnail: {
          url: interaction.member.user.dynamicAvatarURL(null, 64)
        },
        fields: [{
          name: '通常の招待（最小権限）',
          value: `[この招待リンク](https://discord.com/oauth2/authorize?client_id=${global.bot.user.id}&scope=bot+applications.commands&permissions=537218176) から、必要最小限の権限で招待できます。`
        }, {
          name: '招待トラッキング用（サーバー管理・チャンネル管理が必要）',
          value: `Use [this invite link](https://discord.com/oauth2/authorize?client_id=${global.bot.user.id}&scope=bot+applications.commands&permissions=537218224) to invite me with the permissions required for invite tracking join logging. \`Manage Channels\` (can be channel permission overwrites) and \`Manage Server\` are **required** for invite logging on join because Discord does not send invite information to the bot without it. (Manage Channels: receives invites made for channels realtime | Manage Server: to fetch server invites)`
        }],
        footer: getEmbedFooter(global.bot.user)
      }],
      flags: Eris.Constants.MessageFlags.EPHEMERAL
    })
  }
}
