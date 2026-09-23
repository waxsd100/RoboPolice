const { LEGAL_LINKS, SUPPORT_SERVER_URL } = require('../utils/constants')
module.exports = {
  func: async message => {
    await message.channel.createMessage({
      embeds: [{
        title: '設定ダッシュボード',
        description: `${global.bot.user.username} です。設定されたチャンネルへサーバーの出来事を記録することだけが役割です。詳しくは \`/help\` をご覧ください。`,
        color: 3553599,
        timestamp: new Date(),
        footer: {
          icon_url: global.bot.user.avatarURL,
          text: `${global.bot.user.username}#${global.bot.user.discriminator}`
        },
        thumbnail: {
          url: global.bot.user.avatarURL
        },
        author: {
          name: `${message.author.username}#${message.author.discriminator}`,
          icon_url: message.author.avatarURL
        },
        fields: [
          {
            name: 'Technical Details',
            value: `${global.bot.user.username} is written in JavaScript utilizing the Node.js runtime. It uses the [eris](https://github.com/abalabahaha/eris) library to interact with the Discord API. PostgreSQL and Redis are used. I am OSS at https://github.com/waxsd100/RoboPolice`
          },
          {
            name: '開発元',
            value: `${global.bot.user.username} is a fork of [Logger](https://github.com/curtisf/logger), maintained for one community server. Support: ${SUPPORT_SERVER_URL}`
          },
          {
            name: 'シャード情報',
            value: `シャードID: ${message.channel.guild.shard.id}\nWebSocket遅延: ${message.channel.guild.shard.latency}\n状態: ${message.channel.guild.shard.status}`
          },
          {
            name: 'プライバシーポリシー',
            value: `[Privacy Policy](${LEGAL_LINKS.PRIVACY_POLICY}) | [Terms of Service](${LEGAL_LINKS.TERMS_OF_SERVICE})`
          }
        ]
      }]
    })
  },
  name: 'info',
  quickHelp: 'BOTの情報と、現在担当しているシャードの状態を表示します。',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}info\``,
  type: 'any',
  category: 'Information'
}
