const cacheGuild = require('../utils/cacheGuild')
const deleteGuild = require('../../db/interfaces/postgres/delete').deleteGuild
const createGuild = require('../../db/interfaces/postgres/create').createGuild

module.exports = {
  func: async message => {
    const msg = await message.channel.createMessage({
      embeds: [{
        description: `本当によろしいですか、${message.author.username}#${message.author.discriminator} (${message.author.id}) さん。よろしければ *yes* と返信してください。`,
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
    let i = 0
    let complete = false
    global.bot.on('messageCreate', async function temp (m) {
      if (i === 0) {
        const timeout = setTimeout(() => {
          global.bot.removeListener('messageCreate', temp)
          if (!complete) {
            message.channel.createMessage({
              embeds: [{
                description: '10秒以内に *yes* の返信がありませんでした。',
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
            msg.delete()
          }
        }, 10000)
      }
      if (m.channel.id === message.channel.id && m.author.id === message.author.id && m.content.toLowerCase() === 'yes' && !complete) {
        message.channel.createMessage({
          embeds: [{
            description: 'サーバーの設定をリセットします。',
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
        complete = true
        await deleteGuild(message.channel.guild.id)
        await createGuild(message.channel.guild)
        await cacheGuild(message.channel.guild.id)
        return
      }
      i = i + 1
    })
  },
  name: 'reset',
  quickHelp: 'このサーバーに保存されている設定をすべてリセットします。ログ機能を停止・初期化したい場合に使用してください。',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}reset\` <- 確認（yes と返信）のうえでサーバーのログ設定を消去します。`,
  type: 'admin',
  category: 'Administration'
}
