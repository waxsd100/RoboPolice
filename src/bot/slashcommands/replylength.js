// How long the mention assistant's replies are in this server: long (the default, up to about 500
// characters), normal (fitted to what was said) or short. Without a choice, shows the setting.
const { setReplyLength, getReplyLength } = require('../../db/interfaces/postgres/replySettings')
const { DEFAULT_REPLY_LENGTH } = require('../modules/eventDrafter')

const LABELS = {
  long: '長め（長くても500文字程度）',
  normal: '内容に合わせる（あいさつは短く、説明は長めに）',
  short: '短め（答えだけ。長くても200文字程度）'
}

module.exports = {
  name: 'replylength',
  userPerms: ['manageGuild'],
  func: async interaction => {
    try {
      const length = interaction.data?.options?.find(o => o.name === 'length')?.value
      if (!length) {
        const current = await getReplyLength(interaction.guildID) || DEFAULT_REPLY_LENGTH
        return await interaction.createMessage({ content: `このサーバーでの返事の長さ: **${LABELS[current]}**\n\`/replylength length:\` で変えられます。`, flags: 64 })
      }
      if (!LABELS[length]) return await interaction.createMessage({ content: '長さは long・normal・short から選んでください。', flags: 64 })
      await setReplyLength(interaction.guildID, length)
      await interaction.createMessage({ content: `このサーバーでの返事の長さを **${LABELS[length]}** にしました。次のメンションから反映されます。` })
    } catch (e) {
      global.logger.error(e)
      await interaction.createMessage({ content: '返事の長さを変えられませんでした。もう一度お試しください。', flags: 64 }).catch(() => {})
    }
  }
}
