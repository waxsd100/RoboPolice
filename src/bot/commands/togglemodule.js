const disableEvent = require('../../db/interfaces/postgres/update').disableEvent
const eventList = require('../utils/constants').ALL_EVENTS

module.exports = {
  func: async (message, suffix) => {
    const split = suffix.split(' ')
    if (!eventList.includes(split[0])) {
      return message.channel.createMessage({
        embeds: [{
          description: `引数が正しくありません。指定できるイベント: ${eventList.join(', ')}`,
          color: 16711680,
          timestamp: new Date(),
          footer: {
            icon_url: global.bot.user.avatarURL,
            text: `${global.bot.user.username}#${global.bot.user.discriminator}`
          },
          author: {
            name: `${message.author.username}#${message.author.discriminator}`,
            icon_url: message.author.avatarURL
          }
        }]
      })
    }
    const disabled = await disableEvent(message.channel.guild.id, split[0])
    const respStr = `${split[0]} を${!disabled ? '有効化' : '無効化'}しました。`
    message.channel.createMessage({
      embeds: [{
        description: respStr,
        color: 3553599,
        timestamp: new Date(),
        footer: {
          icon_url: global.bot.user.avatarURL,
          text: `${global.bot.user.username}#${global.bot.user.discriminator}`
        },
        author: {
          name: `${message.author.username}#${message.author.discriminator}`,
          icon_url: message.author.avatarURL
        }
      }]
    })
  },
  name: 'togglemodule',
  quickHelp: `[非推奨]\n指定したイベントを無視します。${process.env.GLOBAL_BOT_PREFIX}stoplogging で出力を停止できるため、通常は不要です。`,
  examples: 'このコマンドは非推奨です。',
  type: 'custom',
  perm: 'manageChannels',
  category: 'Logging'
}
