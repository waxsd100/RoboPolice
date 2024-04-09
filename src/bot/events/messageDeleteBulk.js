const sa = require('superagent')
const getMessagesByIds = require('../../db/interfaces/postgres/read').getMessagesByIds
const send = require('../modules/webhooksender')
const { EMBED_COLORS } = require('../utils/constants')

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
            description: `${messages.length} messages were bulk deleted. :warning: The bot owner hasn't configured a paste site so contents of deleted messages not shown. :warning:`,
            color: EMBED_COLORS.YELLOW_ORANGE,
        }]
      });
    }

    const dbMessages = await getMessagesByIds(messages.map(m => m.id))
    await paste(dbMessages, messages[0].channel.guild.id)
  }
}

async function paste (messages, guildID) {
  if (!messages) return
  const messageDeleteBulkEvent = {
    guildID: guildID,
    eventName: 'messageDeleteBulk',
    embeds: [{
      description: `**${messages.length}** message(s) were deleted and known in cache.`,
      fields: [],
      color: 15550861
    }]
  }
  const pasteString = messages.reverse().map(m => {
    let globalUser = global.bot.users.get(m.author_id)
    if (!globalUser) {
      globalUser = {
        username: 'Unknown',
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
            name: 'Link',
            value: `${process.env.PASTE_ROOT_URL}/${res.body.key}.txt`
          })
          send(messageDeleteBulkEvent)
        } else {
          global.logger.error(err)
          global.webhook.error('An error has occurred while posting to the paste website. Check logs for more.')
        }
      })
  }
}
