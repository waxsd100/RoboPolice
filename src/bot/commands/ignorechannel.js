const ignoreChannel = require('../../db/interfaces/postgres/update').ignoreChannel

module.exports = {
  func: async (message, suffix) => {
    let toIgnore = message.channel.id
    if (suffix && !isNaN(parseInt(suffix))) {
      const channelToIgnore = message.channel.guild.channels.get(suffix)
      if (!channelToIgnore || !(channelToIgnore.type === 2 || channelToIgnore.type === 0)) return message.channel.createMessage(`Usage: ${process.env.GLOBAL_BOT_PREFIX}ignorechannel OR ${process.env.GLOBAL_BOT_PREFIX}ignorechannel channelID`)
      toIgnore = suffix
    }
    const disabled = await ignoreChannel(message.channel.guild.id, toIgnore) // return a boolean representing whether a channel is ignored or not
    const respStr = `<#${toIgnore}> (${message.channel.guild.channels.get(toIgnore).name}) の設定を切り替えました。このチャンネルのイベントを${disabled ? '記録しません' : '記録します'}`
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
  name: 'ignorechannel',
  quickHelp: 'このコマンドを実行したチャンネルのイベントをログ対象外にします。対象にしたいテキストチャンネルで実行するか、チャンネルID（ボイスチャンネルも可）を引数に指定してください。',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}ignorechannel\` <- 実行したチャンネルのイベントを除外
  \`${process.env.GLOBAL_BOT_PREFIX}ignorechannel voice channel id\` <- 指定したボイスチャンネルのイベントを除外
  \`${process.env.GLOBAL_BOT_PREFIX}ignorechannel text channel id\` <- 指定したテキストチャンネルのイベントを除外`,
  type: 'custom',
  perm: 'manageChannels',
  category: 'Logging'
}
