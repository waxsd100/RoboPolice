// How long the mention assistant's replies are in this server: long (the default, up to about 500
// characters), normal (fitted to what was said) or short. Without a choice, shows the setting.
const { setReplyLength, getReplyLength } = require('../../db/interfaces/postgres/replySettings')
const { DEFAULT_REPLY_LENGTH } = require('../modules/eventDrafter')
const { langOf } = require('../utils/i18n')

const TEXT = {
  ja: {
    labels: { long: '長め（長くても500文字程度）', normal: '内容に合わせる（あいさつは短く、説明は長めに）', short: '短め（答えだけ。長くても200文字程度）' },
    current: label => `このサーバーでの返事の長さ: **${label}**\n\`/replylength length:\` で変えられます。`,
    unknown: '長さは long・normal・short から選んでください。',
    set: label => `このサーバーでの返事の長さを **${label}** にしました。次のメンションから反映されます。`,
    failed: '返事の長さを変えられませんでした。もう一度お試しください。'
  },
  en: {
    labels: { long: 'long (up to about 500 characters)', normal: 'fitted to what was said (short greetings, longer explanations)', short: 'short (just the answer, up to about 200 characters)' },
    current: label => `How long replies are here: **${label}**\nChange it with \`/replylength length:\`.`,
    unknown: 'Choose long, normal or short.',
    set: label => `Replies here are now **${label}**, from the next mention.`,
    failed: 'Could not change how long replies are. Please try again.'
  }
}

module.exports = {
  name: 'replylength',
  userPerms: ['manageGuild'],
  func: async interaction => {
    const text = TEXT[langOf(interaction)]
    try {
      const length = interaction.data?.options?.find(o => o.name === 'length')?.value
      if (!length) {
        const current = await getReplyLength(interaction.guildID) || DEFAULT_REPLY_LENGTH
        return await interaction.createMessage({ content: text.current(text.labels[current]), flags: 64 })
      }
      if (!text.labels[length]) return await interaction.createMessage({ content: text.unknown, flags: 64 })
      await setReplyLength(interaction.guildID, length)
      await interaction.createMessage({ content: text.set(text.labels[length]) })
    } catch (e) {
      global.logger.error(e)
      await interaction.createMessage({ content: text.failed, flags: 64 }).catch(() => {})
    }
  }
}
