// %safety: per-server toggle for Gemini safety filtering (eventDrafter.js). For the bot's
// developers (CREATOR_IDS).
//   %safety                         shows current settings
//   %safety on | off | default      sets Gemini safety filter
//   %safety filter on|off|default   sets Gemini safety filter
const store = require('../../db/interfaces/postgres/replySettings')
const { isOwnerGuild } = require('../utils/priority')

const TARGETS = {
  filter: 'filter',
  safety: 'filter',
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

function describe (guildID, { safety = {}, safetyFilter }) {
  const owner = isOwnerGuild(guildID)
  const prefix = process.env.GLOBAL_BOT_PREFIX
  return [
    'このサーバーの AI セーフティ設定:',
    formatLine('Gemini セーフティフィルタ (`filter`)', safetyFilter, safety.filter, !owner, owner),
    `\`${prefix}safety <on|off|default>\` で切り替えられます。`
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
        return say(`\`on\`・\`off\`・\`default\` を指定してください。\n${await show()}`)
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
