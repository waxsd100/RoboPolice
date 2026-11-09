// %safety: per-server toggles for Gemini safety filtering (eventDrafter.js) and R18 / uncensored
// model handover (UNCENSORED_MODEL). For the bot's developers (CREATOR_IDS).
//   %safety                         shows current settings
//   %safety on | off | default      sets both (on: filter ON + R18 OFF; off: filter OFF + R18 ON)
//   %safety filter on|off|default   sets Gemini safety filter
//   %safety r18 on|off|default      sets R18 / uncensored model handover
const store = require('../../db/interfaces/postgres/replySettings')
const { isOwnerGuild } = require('../utils/priority')

const TARGETS = {
  filter: 'filter',
  safety: 'filter',
  r18: 'uncensored',
  uncensored: 'uncensored',
  all: 'all'
}

const VALUES = {
  on: true,
  strict: true,
  off: false,
  relaxed: false,
  default: null
}

function formatLine (label, effective, explicit, defaultEffective, owner) {
  const state = effective ? 'オン' : 'オフ'
  const source = explicit === null || explicit === undefined
    ? `（既定：${owner ? 'オーナーサーバーのため' : ''}${defaultEffective ? 'オン' : 'オフ'}）`
    : '（このサーバーの設定）'
  return `- ${label}: ${state}${source}`
}

function describe (guildID, { safety = {}, safetyFilter, uncensoredR18 }) {
  const owner = isOwnerGuild(guildID)
  const prefix = process.env.GLOBAL_BOT_PREFIX
  return [
    'このサーバーの AI セーフティ・R18 設定:',
    formatLine('Gemini セーフティフィルタ (`filter`)', safetyFilter, safety.filter, !owner, owner),
    formatLine('R18・検閲なしモデル引き継ぎ (`r18`)', uncensoredR18, safety.uncensored, owner, owner),
    `\`${prefix}safety [filter|r18] <on|off|default>\` で個別に切り替えられます。`,
    `（対象省略時の \`${prefix}safety on\` は「フィルタ オン＋R18引き継ぎ オフ」、\`${prefix}safety off\` は「フィルタ オフ＋R18引き継ぎ オン」に一括変更します）`
  ].join('\n')
}

module.exports = {
  func: async (message, suffix) => {
    const guildID = message.channel.guild.id
    const say = content => message.channel.createMessage({ content, messageReference: { messageID: message.id } })
    const tokens = String(suffix || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    try {
      const show = async () => describe(guildID, await store.getReplySettings(guildID))
      if (!tokens.length) return say(await show())
      let target = 'all'
      let raw = tokens[0]
      if (tokens.length >= 2 || TARGETS[tokens[0]]) {
        target = TARGETS[tokens[0]]
        raw = tokens[1]
      }
      if (!target || !(raw in VALUES)) {
        return say(`\`filter\` / \`r18\`（または省略）と \`on\`・\`off\`・\`default\` を指定してください。\n${await show()}`)
      }
      await store.setSafety(guildID, target, VALUES[raw])
      return say(`変更しました。\n${await show()}`)
    } catch (e) {
      global.logger.warn(`Could not change the safety settings of ${guildID}: ${e.message}`)
      return say('設定を変えられませんでした。')
    }
  },
  name: 'safety',
  description: 'Bot owner debug command.',
  type: 'creator',
  noDM: true,
  hidden: true
}
