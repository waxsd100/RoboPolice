const sa = require('superagent')
const { EMBED_COLORS } = require('../utils/constants.js')
const { getEmbedFooter, getAuthorField } = require('../utils/embeds.js')

module.exports = {
  name: 'archive',
  botPerms: ['readMessageHistory'],
  userPerms: ['readMessageHistory', 'manageMessages'],
  func: async interaction => {
    if (!process.env.PASTE_SITE_ROOT_URL) return interaction.createMessage({
      embeds: [{
        title: '失敗',
        description: 'BOTの管理者が paste サイトを設定していないため、このコマンドは利用できません。',
        thumbnail: {
          url: interaction.member.user.dynamicAvatarURL(null, 64)
        },
        color: EMBED_COLORS.RED,
        footer: getEmbedFooter(global.bot.user),
        author: getAuthorField(interaction.member.user)
      }]
    }).catch(() => {})
    if (!interaction.data.options || !interaction.data.options[0] || interaction.data.options[0].value > 1000 || interaction.data.options[0].value < 5) {
      interaction.createMessage({
        embeds: [{
          title: '失敗',
          description: '件数は 5 以上 1000 未満で指定してください。',
          thumbnail: {
            url: interaction.member.user.dynamicAvatarURL(null, 64)
          },
          color: EMBED_COLORS.RED,
          footer: getEmbedFooter(global.bot.user),
          author: getAuthorField(interaction.member.user)
        }]
      }).catch(() => {})
    }
    const fetchedMessages = await global.bot.getChannel(interaction.channel.id).getMessages({ limit: interaction.data.options[0].value })
    const pasteString = fetchedMessages.reverse().filter(m => !m.applicationID).map(m => `${m.author.username}#${m.author.discriminator} (${m.author.id}) | ${new Date(m.timestamp)}: ${m.content ? m.content : ''} | ${m.embeds.length === 0 ? '' : `{"embeds": [${m.embeds.map(e => JSON.stringify(e))}]}`} | ${m.attachments.length === 0 ? '' : ` =====> Attachment: ${m.attachments[0].filename}:${m.attachments[0].url}`}`).join('\r\n')
    try {
      await interaction.createMessage({
        embeds: [{ // make sure followup message is created before doing any more work
          title: '処理中',
          description: `${interaction.member.username}#${interaction.member.discriminator} からの ${interaction.data.options[0].value} 件のアーカイブ要求を処理しています`,
          thumbnail: {
            url: interaction.member.user.dynamicAvatarURL(null, 64)
          },
          color: EMBED_COLORS.YELLOW_ORANGE,
          footer: getEmbedFooter(global.bot.user),
          author: getAuthorField(interaction.member.user)
        }]
      })
    } catch (_) {}
    sa
      .post(`${process.env.PASTE_SITE_ROOT_URL}/documents`)
      .set('Content-Type', 'text/plain')
      .send(pasteString || 'No messages were able to be archived')
      .end((err, res) => {
        if (!err && res.statusCode === 200 && res.body.key) {
          interaction.editOriginalMessage({
            embeds: [{
              title: '成功',
              description: `${fetchedMessages.length} 件のメッセージをアーカイブしました: ${process.env.PASTE_SITE_ROOT_URL}/${res.body.key}.txt`,
              thumbnail: {
                url: interaction.member.user.dynamicAvatarURL(null, 64)
              },
              color: EMBED_COLORS.GREEN,
              footer: getEmbedFooter(global.bot.user),
              author: getAuthorField(interaction.member.user)
            }]
          }).catch(() => {})
        } else {
          interaction.editOriginalMessage({
            embeds: [{
              title: 'エラー',
              description: 'アーカイブサービスがエラーを返しました。時間をおいて再度お試しください。',
              thumbnail: {
                url: interaction.member.user.dynamicAvatarURL(null, 64)
              },
              color: EMBED_COLORS.RED,
              footer: getEmbedFooter(global.bot.user)
            }]
          }).catch(() => {})
          global.logger.error(err, res.body)
          global.webhook.error('An error has occurred while posting to the paste website. Check logs for more.')
        }
      })
  }
}
