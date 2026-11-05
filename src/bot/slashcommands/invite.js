const Eris = require('eris')
const { EMBED_COLORS } = require('../utils/constants.js')
const { getEmbedFooter } = require('../utils/embeds')
const { pick } = require('../utils/i18n')

module.exports = {
  name: 'invite',
  func: async interaction => {
    const id = global.bot.user.id
    const basic = `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot+applications.commands&permissions=537218176`
    const tracking = `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot+applications.commands&permissions=537218224`
    interaction.createMessage({
      embeds: [{
        title: pick(interaction, { ja: '招待リンク', en: 'Invite links' }),
        description: pick(interaction, {
          ja: '用途別の招待リンクです。必要最小限の権限だけを付与できるよう（最小権限の原則）、目的ごとに分けてあります。\n\n招待したあとの設定方法は `/help guide: 使い方` を参照してください。',
          en: 'Invite links by what they are for, so the bot is given no more permissions than it needs.\n\nSee `/help guide: Usage` for setting it up once invited.'
        }),
        color: EMBED_COLORS.PURPLED_BLUE,
        thumbnail: {
          url: interaction.member.user.dynamicAvatarURL(null, 64)
        },
        fields: [{
          name: pick(interaction, { ja: '通常の招待（最小権限）', en: 'Usual invite (fewest permissions)' }),
          value: pick(interaction, {
            ja: `[この招待リンク](${basic}) から、必要最小限の権限で招待できます。`,
            en: `[This invite link](${basic}) invites the bot with the fewest permissions it needs.`
          })
        }, {
          name: pick(interaction, { ja: '招待トラッキング用（サーバーの管理・チャンネルの管理が必要）', en: 'With invite tracking (needs Manage Server and Manage Channels)' }),
          value: pick(interaction, {
            ja: `[この招待リンク](${tracking}) から、参加ログで使われた招待を記録するのに必要な権限つきで招待できます。Discord はこれらの権限が無いと BOT に招待の情報を送らないため、\`チャンネルの管理\`（チャンネル単位の権限の上書きでも可）と \`サーバーの管理\` が**必要**です（チャンネルの管理: 作られた招待をその場で受け取る / サーバーの管理: サーバーの招待一覧を取得する）。`,
            en: `[This invite link](${tracking}) invites the bot with the permissions it needs to log the invite a member joined with. \`Manage Channels\` (a channel permission overwrite will do) and \`Manage Server\` are **required**, as Discord does not send the bot invites without them (Manage Channels: invites as they are made / Manage Server: the server's invites).`
          })
        }],
        footer: getEmbedFooter(global.bot.user)
      }],
      flags: Eris.Constants.MessageFlags.EPHEMERAL
    })
  }
}
