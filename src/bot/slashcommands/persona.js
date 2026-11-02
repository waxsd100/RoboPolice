// Whether the mention assistant speaks as the streamer of the server's YouTube channel (the
// default) or as the server's bot. Without a choice, shows the setting.
const { setStreamerPersona, getReplySettings } = require('../../db/interfaces/postgres/replySettings')

const LABELS = {
  true: '配信者として（チャンネルの配信者本人になりきって話す）',
  false: 'BOT として（配信者にはなりきらず、サーバーの BOT として話す）'
}

module.exports = {
  name: 'persona',
  userPerms: ['manageGuild'],
  func: async interaction => {
    try {
      const option = interaction.data?.options?.find(o => o.name === 'streamer')
      if (!option) {
        const { streamerPersona } = await getReplySettings(interaction.guildID)
        return await interaction.createMessage({ content: `このサーバーでの話し方: **${LABELS[streamerPersona !== false]}**\n\`/persona streamer:\` で変えられます。`, flags: 64 })
      }
      const enabled = option.value === true
      await setStreamerPersona(interaction.guildID, enabled)
      await interaction.createMessage({ content: `このサーバーでの話し方を **${LABELS[enabled]}** にしました。次のメンションから反映されます。` })
    } catch (e) {
      global.logger.error(e)
      await interaction.createMessage({ content: '話し方を変えられませんでした。もう一度お試しください。', flags: 64 }).catch(() => {})
    }
  }
}
