// /assistantrules: what this server's moderators ask the mention assistant to keep to (topics to
// avoid, words not to use, spoilers…), on top of the server's rules channel, which it reads by
// itself (serverRules.js). Without options, shows them; `text` sets them; `clear` removes them.
const Eris = require('eris')
const { setAssistantRules, getReplySettings } = require('../../db/interfaces/postgres/replySettings')
const { rulesChannels } = require('../modules/serverRules')
const { langOf } = require('../utils/i18n')

const MAX_CHARS = 2000
const DISCORD_CONTENT_LIMIT = 2000

function clampContent (str, max = DISCORD_CONTENT_LIMIT) {
  const s = String(str ?? '')
  if (s.length <= max) return s
  let cut = s.slice(0, max - 1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1)
  return `${cut}…`
}

const TEXT = {
  ja: {
    none: 'なし',
    show: (rules, channels) => {
      const footer = channels.length
        ? `サーバーのルールは ${channels.map(id => `<#${id}>`).join('・')} から読んで、それにも従います（チャンネル名と説明から AI が選びました）。`
        : 'ルールや必読のチャンネルが見つからないため、サーバーのルールは読んでいません（Discord のサーバー設定でルールチャンネルを決めると読みます）。'
      const safeFooter = clampContent(footer, 500)
      const header = '**AI へのお願い（このサーバーのモデレーターから）**\n'
      const budget = Math.max(100, DISCORD_CONTENT_LIMIT - header.length - safeFooter.length - 8)
      const body = rules ? `>>> ${clampContent(rules, budget)}` : 'なし（`/assistantrules text:` で設定できます）'
      return clampContent([header.trimEnd(), body, '', safeFooter].join('\n'))
    },
    set: '保存しました。次のメンションから、AI はこれに従って返事をします。',
    cleared: 'AI へのお願いを消しました。',
    tooLong: `${MAX_CHARS} 文字までにしてください。`,
    failed: '保存できませんでした。もう一度お試しください。'
  },
  en: {
    none: 'none',
    show: (rules, channels) => {
      const footer = channels.length
        ? `It also reads the server's rules in ${channels.map(id => `<#${id}>`).join(', ')} and keeps to them (picked by AI from the channels' names and topics).`
        : 'No rules or must-read channel was found, so the server\'s rules are not read (set a rules channel in the server settings).'
      const safeFooter = clampContent(footer, 500)
      const header = '**What the moderators ask of the assistant**\n'
      const budget = Math.max(100, DISCORD_CONTENT_LIMIT - header.length - safeFooter.length - 8)
      const body = rules ? `>>> ${clampContent(rules, budget)}` : 'Nothing (set it with `/assistantrules text:`).'
      return clampContent([header.trimEnd(), body, '', safeFooter].join('\n'))
    },
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
    let deferred = false
    const reply = payload => {
      if (deferred && typeof interaction.editOriginalMessage === 'function') {
        const { flags, ...rest } = payload
        return interaction.editOriginalMessage(rest)
      }
      return interaction.createMessage(payload)
    }
    try {
      const rules = String(option('text') || '').trim()
      if (option('clear') !== true && rules && [...rules].length > MAX_CHARS) {
        return await interaction.createMessage({ content: text.tooLong, flags: Eris.Constants.MessageFlags.EPHEMERAL })
      }
      if (typeof interaction.defer === 'function') {
        await interaction.defer(Eris.Constants.MessageFlags.EPHEMERAL)
        deferred = true
      }
      if (option('clear') === true) {
        await setAssistantRules(interaction.guildID, null)
        return await reply({ content: text.cleared, flags: Eris.Constants.MessageFlags.EPHEMERAL })
      }
      if (!rules) {
        const { assistantRules } = await getReplySettings(interaction.guildID)
        const guild = global.bot.guilds.get(interaction.guildID)
        const channels = guild ? (await rulesChannels(guild).catch(() => [])).map(c => c.id) : []
        const content = text.show(assistantRules, channels)
        return await reply({ content, flags: Eris.Constants.MessageFlags.EPHEMERAL })
      }
      await setAssistantRules(interaction.guildID, rules)
      const echoBudget = Math.max(100, DISCORD_CONTENT_LIMIT - text.set.length - 6)
      await reply({
        content: clampContent(`${text.set}\n>>> ${clampContent(rules, echoBudget)}`),
        flags: Eris.Constants.MessageFlags.EPHEMERAL
      })
    } catch (e) {
      global.logger.error(e)
      await reply({ content: text.failed, flags: Eris.Constants.MessageFlags.EPHEMERAL }).catch(() => {})
    }
  }
}
