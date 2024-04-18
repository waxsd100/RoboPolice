const sa = require('superagent')
const { EMBED_COLORS } = require('../utils/constants.js')
const { getEmbedFooter, getAuthorField } = require('../utils/embeds.js')

module.exports = {
  name: 'archive',
  botPerms: ['readMessageHistory'],
  userPerms: ['readMessageHistory', 'manageMessages'],
  func: async interaction => {
    if (!interaction.data.options || !interaction.data.options[0] || interaction.data.options[0].value > 1000 || interaction.data.options[0].value < 5) {
      interaction.createMessage({
        embeds: [{
          title: 'Unsuccessful',
          description: 'Amount must be 5 <= amount < 1000',
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
    fetchedMessages.reverse()
    const pasteString = fetchedMessages
      .filter(m => !m.applicationID)
      .map(m => `${m.author.username}#${m.author.discriminator} (${m.author.id}) | ${new Date(m.timestamp)}: ${m.content ? m.content : ''} | ${m.embeds.length === 0 ? '' : `{"embeds": [${m.embeds.map(e => JSON.stringify(e))}]}`} | ${m.attachments.length === 0 ? '' : ` =====> Attachment: ${m.attachments[0].filename}:${m.attachments[0].url}`}`)
      .join('\r\n')

    if (process.env.PASTE_CREATE_ENDPOINT !== '') {
      sa
        .post(process.env.PASTE_CREATE_ENDPOINT)
        .set('Authorization', process.env.PASTE_CREATE_TOKEN)
        .set('Content-Type', 'text/plain')
        .send(pasteString || 'No messages were able to be archived')
        .end((err, res) => {
          if (!err && res.statusCode === 200 && res.body.key) {
            interaction.createMessage({
              embeds: [{
                title: 'Success',
                description: `Archived ${fetchedMessages.length} messages: ${process.env.PASTE_BASE_URL}/${res.body.key}.txt`,
                thumbnail: {
                  url: interaction.member.user.dynamicAvatarURL(null, 64)
                },
                color: EMBED_COLORS.GREEN,
                footer: getEmbedFooter(global.bot.user),
                author: getAuthorField(interaction.member.user)
              }]
            }).catch((e) => { console.error(e) })
          } else {
            console.error(err)
          }
        })
    } else {
      await interaction.createMessage({
        embeds: [{
          title: 'Success',
          description: `Archived ${fetchedMessages.length} messages`,
          thumbnail: {
            url: interaction.member.user.dynamicAvatarURL(null, 64)
          },
          color: EMBED_COLORS.GREEN,
          footer: getEmbedFooter(global.bot.user),
          author: getAuthorField(interaction.member.user)
        }]
      }, {
        name: 'archive.txt',
        file: Buffer.from(pasteString ?? 'no content')
      })
    }
  }
}
