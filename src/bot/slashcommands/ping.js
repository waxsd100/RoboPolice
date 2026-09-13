const { EMBED_COLORS } = require('../utils/constants.js')

module.exports = {
  name: 'ping',
  func: async interaction => {
    const start = new Date().getTime()
    try {
      await interaction.createMessage({
        embeds: [{
          title: 'Pong',
          description: `RTT を計測中です。ゲートウェイ遅延: ${global.bot.getChannel(interaction.channel.id).guild.shard.latency} ms`,
          thumbnail: {
            url: interaction.member.user.dynamicAvatarURL(null, 64)
          },
          color: EMBED_COLORS.YELLOW_ORANGE
        }]
      })

      await interaction.editOriginalMessage({
        embeds: [{
          title: 'Pong',
          description: `稼働中です。ゲートウェイ遅延: ${global.bot.getChannel(interaction.channel.id).guild.shard.latency} ms / RTT: ${new Date().getTime() - start} ms`,
          thumbnail: {
            url: interaction.member.user.dynamicAvatarURL(null, 64)
          },
          color: EMBED_COLORS.GREEN
        }]
      })
    } catch (_) {}
  }
}
