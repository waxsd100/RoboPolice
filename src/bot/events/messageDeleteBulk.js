const sa = require('superagent')
const getMessagesByIds = require('../../db/interfaces/postgres/read').getMessagesByIds
const send = require('../modules/webhooksender')
const { EMBED_COLORS } = require('../utils/constants')
const { isBeyondRetention } = require('../utils/retention')

module.exports = {
  name: 'messageDeleteBulk',
  type: 'on',
  handle: async messages => {
    if (messages.length === 0) return // TODO: TEST!

    if (!process.env.PASTE_SITE_ROOT_URL) {
      if (!messages[0].guildId) return;
  
      return send({
        guildID: messages[0].guildId,
        eventName: 'messageDeleteBulk',
        embeds: [{
            description: `${messages.length} 件のメッセージが一括削除されました。:warning: pasteサイトが設定されていないため、削除されたメッセージの内容は表示されません。:warning:`,
            color: EMBED_COLORS.YELLOW_ORANGE,
        }]
      });
    }

    const guildID = messages[0].channel?.guild?.id || messages[0].guildID || messages[0].guildId
    if (!guildID) return
    const dbMessages = await getMessagesByIds(messages.map(m => m.id))
    if (!dbMessages) {
      // getMessagesByIds returns null when nothing matched. If the newest of the batch is past the
      // retention window they were all pruned, so report the deletion rather than dropping it.
      const newestID = messages.reduce((a, b) => BigInt(a.id) > BigInt(b.id) ? a : b).id // snowflakes vary in length, so compare numerically
      if (isBeyondRetention(newestID)) {
        await send({
          guildID,
          eventName: 'messageDeleteBulk',
          embeds: [{
            description: `**${messages.length}** 件のメッセージが一括削除されました。保持期間（${process.env.MESSAGE_HISTORY_DAYS}日）を過ぎているため、内容は取得できません。`,
            color: EMBED_COLORS.YELLOW_ORANGE
          }]
        })
      }
      return
    }
    await paste(dbMessages, guildID)
  }
}

async function paste (messages, guildID) {
  if (!messages) return
  const messageDeleteBulkEvent = {
    guildID: guildID,
    eventName: 'messageDeleteBulk',
    embeds: [{
      description: `**${messages.length}** 件のメッセージが一括削除されました（キャッシュにあった分）。`,
      fields: [],
      color: 15550861
    }]
  }
  const pasteString = messages.reverse().map(m => {
    let globalUser = global.bot.users.get(m.author_id)
    if (!globalUser) {
      globalUser = {
        username: '不明',
        discriminator: '0000',
        avatarURL: '<no avatar>'
      }
    }
    return `${globalUser.username}#${globalUser.discriminator} (${m.author_id}) | (${globalUser.avatarURL}) | ${new Date(m.ts).toUTCString()}: ${m.content}`
  }).join('\r\n')
  if (pasteString) {
    sa
      .post(`${process.env.PASTE_SITE_ROOT_URL}/documents`)
      .set('Content-Type', 'text/plain')
      .send(pasteString || 'An error has occurred while fetching pastes. Please contact the bot author.')
      .end((err, res) => {
        if (!err && res.body && res.statusCode === 200 && res.body.key) {
          messageDeleteBulkEvent.embeds[0].fields.push({
            name: 'リンク',
            value: `${process.env.PASTE_SITE_ROOT_URL}/${res.body.key}.txt`
          })
          send(messageDeleteBulkEvent)
        } else {
          global.logger.error(err)
          global.webhook.error('An error has occurred while posting to the paste website. Check logs for more.')
        }
      })
  }
}
