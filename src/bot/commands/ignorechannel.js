const ignoreChannel = require('../../db/interfaces/postgres/update').ignoreChannel
const cacheGuild = require('../utils/cacheGuild')

module.exports = {
  func: async (message, suffix = '') => {
    if (!message?.channel?.guild) return
    if (!global.bot.guildSettingsCache?.[message.channel.guild.id]) {
      await cacheGuild(message.channel.guild.id)
    }
    let toIgnore = message.channel.id
    const trimmedSuffix = (suffix || '').trim()
    if (trimmedSuffix) {
      const cleanedId = trimmedSuffix.replace(/^<#(\d+)>$/, '$1').trim()
      if (!/^\d+$/.test(cleanedId)) {
        return message.channel.createMessage(`Usage: ${process.env.GLOBAL_BOT_PREFIX}ignorechannel OR ${process.env.GLOBAL_BOT_PREFIX}ignorechannel channelID`)
      }
      const channelToIgnore = message.channel.guild.channels?.get?.(cleanedId)
      if (!channelToIgnore || (channelToIgnore.guild && channelToIgnore.guild.id !== message.channel.guild.id) || !(channelToIgnore.type === 2 || channelToIgnore.type === 0)) {
        return message.channel.createMessage(`Usage: ${process.env.GLOBAL_BOT_PREFIX}ignorechannel OR ${process.env.GLOBAL_BOT_PREFIX}ignorechannel channelID`)
      }
      toIgnore = cleanedId
    }
    const disabled = await ignoreChannel(message.channel.guild.id, toIgnore) // return a boolean representing whether a channel is ignored or not
    await cacheGuild(message.channel.guild.id)
    const channelName = message.channel.guild.channels?.get?.(toIgnore)?.name || message.channel.name || toIgnore
    const respStr = `<#${toIgnore}> (${channelName}) の設定を切り替えました。このチャンネルのイベントを${disabled ? '記録しません' : '記録します'}`
    await message.channel.createMessage({
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
  name: 'ignorechannel',
  quickHelp: 'このコマンドを実行したチャンネルのイベントをログ対象外にします。対象にしたいテキストチャンネルで実行するか、チャンネルID（ボイスチャンネルも可）を引数に指定してください。',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}ignorechannel\` <- 実行したチャンネルのイベントを除外
  \`${process.env.GLOBAL_BOT_PREFIX}ignorechannel ボイスチャンネルID\` <- 指定したボイスチャンネルのイベントを除外
  \`${process.env.GLOBAL_BOT_PREFIX}ignorechannel テキストチャンネルID\` <- 指定したテキストチャンネルのイベントを除外`,
  type: 'custom',
  perm: 'manageChannels',
  category: 'Logging'
}
