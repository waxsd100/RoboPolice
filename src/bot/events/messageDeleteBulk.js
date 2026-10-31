const send = require('../modules/webhooksender')
const { EMBED_COLORS } = require('../utils/constants')
const discordKnowledge = require('../modules/discordKnowledge')

module.exports = {
  name: 'messageDeleteBulk',
  type: 'on',
  handle: async messages => {
    if (messages.length === 0) return
    for (const m of messages) discordKnowledge.onDelete(m.id).catch(e => global.logger.warn(`[DISCORD]: ${e.message}`))

    // Eris populates this differently depending on whether the deleted messages were cached
    // (channel.guild.id) or arrived as raw gateway stubs (guildID/guildId).
    const guildID = messages[0].channel?.guild?.id || messages[0].guildID || messages[0].guildId
    if (!guildID) return

    await send({
      guildID,
      eventName: 'messageDeleteBulk',
      embeds: [{
        description: `**${messages.length}** 件のメッセージが一括削除されました。`,
        color: EMBED_COLORS.YELLOW_ORANGE
      }]
    })
  }
}
