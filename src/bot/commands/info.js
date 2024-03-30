module.exports = {
  func: async message => {
    await message.channel.createMessage({
      embeds: [{
        title: 'Configuration dashboard',
        description: `Hey, I'm ${global.bot.user.username}! My **only** purpose is to, at your command, log everything to your configured channels. Use the slash commands to configure me! For more info, use \`/help\``,
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
            value: `${global.bot.user.username} is written in JavaScript utilizing the Node.js runtime. It uses the [eris](https://github.com/abalabahaha/eris) library to interact with the Discord API. PostgreSQL and Redis are used. I am OSS at https://github.com/tizzysaurus/logger`
          },
          {
            name: 'The Author',
            value: 'TizyLog is a fork of [Logger](https://github.com/curtisf/logger), developed and maintained by \`@tizzysaurus\`.'
          },
          {
            name: 'Shard Info',
            value: `Shard ID: ${message.channel.guild.shard.id}\nWebsocket latency: ${message.channel.guild.shard.latency}\nStatus: ${message.channel.guild.shard.status}`
          },
          {
            name: 'Privacy Policy',
            value: 'For up-to-date privacy information, please contact \`@tizzysaurus\`.'
          }
        ]
      }]
    })
  },
  name: 'info',
  quickHelp: 'Get information about how Logger was made and the current shard serving you.',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}info\``,
  type: 'any',
  category: 'Information'
}
