// %tokenlimit: this server's own mention token limits (mentionQuota.js). For the bot's developers
// (CREATOR_IDS): a server's limits are what the bot's owner pays for.
//   %tokenlimit                     shows them
//   %tokenlimit 5h 300000           per user in five hours (0: no limit)
//   %tokenlimit week 1500000        per user in a week (0: no limit)
//   %tokenlimit flex 70             the share (%) of either at which mentions go to Flex (0: never)
//   %tokenlimit 5h default          back to the default (likewise week, flex)
const store = require('../../db/interfaces/postgres/replySettings')
const { WINDOWS, windowLimit, flexAt } = require('../utils/mentionQuota')

const WHICH = { '5h': '5h', week: 'week', flex: 'flexAt' }
const n = x => x.toLocaleString('en-US')

function describe (limits) {
  const own = which => limits[which] === null || limits[which] === undefined ? '（既定）' : '（このサーバーの設定）'
  const line = w => {
    const limit = windowLimit(w, limits)
    return `- ${w.label}あたり: ${limit ? `${n(limit)} トークン` : '上限なし'}${own(w.name)}`
  }
  const share = Math.round(flexAt(limits) * 100)
  return [
    'このサーバーのメンションのトークン上限（1人あたり、使った量はサーバーをまたいで数えます）:',
    ...WINDOWS.map(line),
    `- 低速モード（Flex）に切り替える目安: ${share ? `上限の ${share}%` : 'しない'}${own('flexAt')}`,
    `\`${process.env.GLOBAL_BOT_PREFIX}tokenlimit 5h 300000\` / \`week 1500000\` / \`flex 70\` / \`5h default\` で変えられます（0 は上限なし・切り替えなし）。`
  ].join('\n')
}

module.exports = {
  func: async (message, suffix) => {
    const guildID = message.channel.guild.id
    const say = content => message.channel.createMessage({ content, messageReference: { messageID: message.id } })
    const [name, raw] = String(suffix || '').trim().toLowerCase().split(/\s+/)
    try {
      if (!name) return say(describe((await store.getReplySettings(guildID)).tokenLimits || {}))
      const which = WHICH[name]
      if (!which) return say(`\`5h\`・\`week\`・\`flex\` のどれかを指定してください。\n${describe((await store.getReplySettings(guildID)).tokenLimits || {})}`)
      let value = null
      if (raw !== 'default') {
        value = Number(String(raw || '').replace(/[,_]/g, ''))
        const max = which === 'flexAt' ? 100 : 2 ** 31 - 1
        if (!raw || !Number.isInteger(value) || value < 0 || value > max) {
          return say(which === 'flexAt' ? '0〜100 の整数（%）か `default` を指定してください。' : '0 以上の整数（トークン）か `default` を指定してください。')
        }
      }
      await store.setTokenLimit(guildID, which, value)
      return say(`変更しました。\n${describe((await store.getReplySettings(guildID)).tokenLimits || {})}`)
    } catch (e) {
      global.logger.warn(`Could not change the token limits of ${guildID}: ${e.message}`)
      return say('設定を変えられませんでした。')
    }
  },
  name: 'tokenlimit',
  description: 'Bot owner debug command.',
  type: 'creator',
  noDM: true,
  hidden: true
}
