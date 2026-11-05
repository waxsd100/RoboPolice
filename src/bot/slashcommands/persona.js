// Whether the mention assistant speaks as the streamer of the server's YouTube channel (the
// default) or as the server's bot. Without a choice, shows the setting.
const { setStreamerPersona, getReplySettings } = require('../../db/interfaces/postgres/replySettings')
const { langOf } = require('../utils/i18n')

const TEXT = {
  ja: {
    labels: { true: '配信者として（チャンネルの配信者本人になりきって話す）', false: 'BOT として（配信者にはなりきらず、サーバーの BOT として話す）' },
    current: label => `このサーバーでの話し方: **${label}**\n\`/persona streamer:\` で変えられます。`,
    set: label => `このサーバーでの話し方を **${label}** にしました。次のメンションから反映されます。`,
    failed: '話し方を変えられませんでした。もう一度お試しください。'
  },
  en: {
    labels: { true: 'as the streamer (speaking as the channel\'s streamer)', false: 'as the bot (speaking as the server\'s bot, not as the streamer)' },
    current: label => `How the assistant speaks here: **${label}**\nChange it with \`/persona streamer:\`.`,
    set: label => `The assistant now speaks **${label}** here, from the next mention.`,
    failed: 'Could not change how the assistant speaks. Please try again.'
  }
}

module.exports = {
  name: 'persona',
  userPerms: ['manageGuild'],
  func: async interaction => {
    const text = TEXT[langOf(interaction)]
    try {
      const option = interaction.data?.options?.find(o => o.name === 'streamer')
      if (!option) {
        const { streamerPersona } = await getReplySettings(interaction.guildID)
        return await interaction.createMessage({ content: text.current(text.labels[streamerPersona !== false]), flags: 64 })
      }
      const enabled = option.value === true
      await setStreamerPersona(interaction.guildID, enabled)
      await interaction.createMessage({ content: text.set(text.labels[enabled]) })
    } catch (e) {
      global.logger.error(e)
      await interaction.createMessage({ content: text.failed, flags: 64 }).catch(() => {})
    }
  }
}
