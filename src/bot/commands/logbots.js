const { toggleLogBots } = require('../../db/interfaces/postgres/update')

module.exports = {
  func: async message => {
    const state = await toggleLogBots(message.channel.guild.id)
    await message.channel.createMessage({
      embeds: [{
        title: `${state ? 'BOTの操作を記録するようにしました。' : 'BOTの操作を記録しないようにしました。'}`,
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
  name: 'logbots',
  quickHelp: 'BOTによる操作を記録するかどうかを切り替えます（既定: 無効）。BOTがメッセージを削除した場合の記録は対象外です。',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}logbots\` <- BOTの操作を記録するかを切り替え、現在の状態を表示`,
  type: 'admin',
  category: 'Logging'
}
