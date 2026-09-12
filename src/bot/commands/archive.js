const sa = require('superagent')

module.exports = {
  func: async (message, suffix) => {
    if (!process.env.PASTE_SITE_ROOT_URL) return message.channel.createMessage('BOTの管理者が paste サイトを設定していないため、このコマンドは利用できません。')
    if (!suffix || isNaN(suffix)) return message.channel.createMessage('引数が正しくありません。5 以上 1000 以下の数値を指定してください。')
    const num = parseInt(suffix)
    if (num < 5 || num > 1000) return message.channel.createMessage('数値が範囲外です。5 以上 1000 以下で指定してください。')
    message.channel.getMessages({ limit: num }).then(messages => {
      const pasteString = messages.reverse().filter(m => !m.applicationID).map(m => `${m.author.username}#${m.author.discriminator} (${m.author.id}) | ${new Date(m.timestamp).toUTCString()}: ${m.content ? m.content : ''} ${m.embeds.length === 0 ? '' : `| {"embeds": [${m.embeds.map(e => JSON.stringify(e))}]}`} | ${m.attachments.length === 0 ? '' : ` =====> Attachment: ${m.attachments[0].filename}:${m.attachments[0].url}`}`).join('\r\n')
      sa
        .post(`${process.env.PASTE_SITE_ROOT_URL}/documents`)
        .set('Content-Type', 'text/plain')
        .send(pasteString || 'アーカイブできるメッセージがありませんでした')
        .end((err, res) => {
          if (!err && res.statusCode === 200 && res.body.key) {
            message.channel.createMessage(`<@${message.author.id}> **${messages.length}** 件のメッセージをアーカイブしました。リンク: ${process.env.PASTE_SITE_ROOT_URL}/${res.body.key}.txt`)
          } else {
            global.logger.error(err, res.body)
            global.webhook.error('An error has occurred while posting to the paste website. Check logs for more.')
          }
        })
    })
  },
  name: 'archive',
  category: 'Utility',
  perm: 'manageMessages',
  quickHelp: 'チャンネルの直近最大1000件のメッセージを外部の paste サイトへ書き出します。メッセージの削除は行いません。',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}archive 5\` <- 指定できる最小件数
  \`${process.env.GLOBAL_BOT_PREFIX}archive 1000\` <- 指定できる最大件数
  \`${process.env.GLOBAL_BOT_PREFIX}archive 25\` <- 直近25件のメッセージを書き出す`
}
