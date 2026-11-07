// /assistantrules: what this server's moderators ask the mention assistant to keep to (topics to
// avoid, words not to use, spoilers…), on top of the server's rules channel, which it reads by
// itself (serverRules.js). Without options, shows them; `text` sets them; `clear` removes them.
const { setAssistantRules, getReplySettings } = require('../../db/interfaces/postgres/replySettings')
const { rulesChannels } = require('../modules/serverRules')
const { langOf } = require('../utils/i18n')

const MAX_CHARS = 2000

const TEXT = {
  ja: {
    none: 'なし',
    show: (rules, channels) => [
      '**AI へのお願い（このサーバーのモデレーターから）**',
      rules ? `>>> ${rules}` : 'なし（`/assistantrules text:` で設定できます）',
      '',
      channels.length ? `サーバーのルールは ${channels.map(id => `<#${id}>`).join('・')} から読んで、それにも従います（チャンネル名と説明から AI が選びました）。` : 'ルールや必読のチャンネルが見つからないため、サーバーのルールは読んでいません（Discord のサーバー設定でルールチャンネルを決めると読みます）。'
    ].join('\n'),
    set: '保存しました。次のメンションから、AI はこれに従って返事をします。',
    cleared: 'AI へのお願いを消しました。',
    tooLong: `${MAX_CHARS} 文字までにしてください。`,
    failed: '保存できませんでした。もう一度お試しください。'
  },
  en: {
    none: 'none',
    show: (rules, channels) => [
      '**What the moderators ask of the assistant**',
      rules ? `>>> ${rules}` : 'Nothing (set it with `/assistantrules text:`).',
      '',
      channels.length ? `It also reads the server's rules in ${channels.map(id => `<#${id}>`).join(', ')} and keeps to them (picked by AI from the channels' names and topics).` : 'No rules or must-read channel was found, so the server\'s rules are not read (set a rules channel in the server settings).'
    ].join('\n'),
    set: 'Saved. The assistant keeps to it from the next mention.',
    cleared: 'Removed what was asked of the assistant.',
    tooLong: `Keep it to ${MAX_CHARS} characters.`,
    failed: 'Could not save it. Please try again.'
  }
}

module.exports = {
  name: 'assistantrules',
  userPerms: ['manageGuild'],
  func: async interaction => {
    const text = TEXT[langOf(interaction)]
    const option = name => interaction.data?.options?.find(o => o.name === name)?.value
    try {
      if (option('clear') === true) {
        await setAssistantRules(interaction.guildID, null)
        return await interaction.createMessage({ content: text.cleared })
      }
      const rules = String(option('text') || '').trim()
      if (!rules) {
        let deferred = false
        const timer = typeof interaction.defer === 'function'
          ? setTimeout(() => { deferred = true; interaction.defer(64).catch(() => {}) }, 1500)
          : null
        timer?.unref?.()
        try {
          const { assistantRules } = await getReplySettings(interaction.guildID)
          const guild = global.bot.guilds.get(interaction.guildID)
          const channels = guild ? (await rulesChannels(guild).catch(() => [])).map(c => c.id) : []
          const content = text.show(assistantRules, channels)
          return deferred && typeof interaction.editOriginalMessage === 'function'
            ? await interaction.editOriginalMessage({ content })
            : await interaction.createMessage({ content, flags: 64 })
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      if ([...rules].length > MAX_CHARS) return await interaction.createMessage({ content: text.tooLong, flags: 64 })
      await setAssistantRules(interaction.guildID, rules)
      await interaction.createMessage({ content: `${text.set}\n>>> ${rules}` })
    } catch (e) {
      global.logger.error(e)
      await interaction.createMessage({ content: text.failed, flags: 64 }).catch(() => {})
    }
  }
}
