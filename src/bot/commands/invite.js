module.exports = {
  func: async message => {
    message.channel.createMessage({
      embeds: [{
        description: `[このリンク](https://discord.com/oauth2/authorize?client_id=${global.bot.user.id}) から招待できます。参加したメンバーが使用した招待コードを記録するには、**チャンネルの管理** と **サーバー管理** の権限が必要です（これらが無いと Discord が招待情報を送信しません）。`,
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
  name: 'invite',
  quickHelp: '権限の異なる招待リンクを表示します。',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}invite\` <- 用途別の招待リンクを表示（必要な権限が少ないものほど安全です）`,
  type: 'any',
  category: 'General'
}
