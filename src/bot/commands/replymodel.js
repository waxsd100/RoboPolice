// %replymodel: the model and thinking level mention replies use in this server (eventDrafter.js).
// For the bot's developers (CREATOR_IDS): a dearer model is what the bot's owner pays for (it also
// uses up the members' token limits faster, mentionQuota.costOf).
//   %replymodel                        shows them
//   %replymodel model gemini-4-argon   this model (one with a price in geminiPrices.js)
//   %replymodel thinking low           this thinking level (minimal, low, medium, high)
//   %replymodel model default          back to the default (likewise thinking)
// The stronger model a reply can hand over to (think_deeper, GEMINI_DEEP_MODEL) is not changed, and
// when the bot is busy (geminiLoad.js) the thinking level is still lowered.
const store = require('../../db/interfaces/postgres/replySettings')
const { DEFAULT_GEMINI_MODEL, THINKING_LEVELS } = require('../modules/eventDrafter')
const { PRICES } = require('../utils/geminiPrices')

// Models that can write a reply: those with a price, but not image models.
function replyModels () {
  let configured = {}
  try {
    configured = JSON.parse(process.env.MENTION_TOKEN_PRICES || '{}') || {}
  } catch (_) {}
  const listed = PRICES.filter(p => p.imageOutput === undefined).map(p => p.model)
  return [...new Set([...listed, ...Object.keys(configured)])].filter(m => /^gemini-[a-z0-9.-]+$/.test(m) && !/image/.test(m))
}

function describe ({ replyModel, replyThinking }) {
  const defaultModel = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
  const defaultThinking = String(process.env.GEMINI_THINKING_LEVEL || 'high').toLowerCase()
  const prefix = process.env.GLOBAL_BOT_PREFIX
  return [
    'このサーバーのメンションの返事:',
    `- モデル: ${replyModel || defaultModel}${replyModel ? '（このサーバーの設定）' : '（既定）'}`,
    `- 思考の深さ: ${replyThinking || defaultThinking}${replyThinking ? '（このサーバーの設定）' : '（既定）'}`,
    `\`${prefix}replymodel model <モデル>\` / \`thinking <${THINKING_LEVELS.join('|')}>\` / \`model default\` で変えられます。`,
    `使えるモデル: ${replyModels().map(m => `\`${m}\``).join('、')}`,
    '（強いモデルに任せるとき（think_deeper）のモデルは変わりません。混み合っているときは思考の深さが下がります）'
  ].join('\n')
}

module.exports = {
  func: async (message, suffix) => {
    const guildID = message.channel.guild.id
    const say = content => message.channel.createMessage({ content, messageReference: { messageID: message.id } })
    const [name, raw] = String(suffix || '').trim().toLowerCase().split(/\s+/)
    try {
      const show = async () => describe(await store.getReplySettings(guildID))
      if (!name) return say(await show())
      if (!['model', 'thinking'].includes(name)) return say(`\`model\` か \`thinking\` を指定してください。\n${await show()}`)
      let value = null
      if (raw !== 'default') {
        const allowed = name === 'model' ? replyModels() : THINKING_LEVELS
        if (!allowed.includes(raw)) return say(`${allowed.map(v => `\`${v}\``).join('・')} か \`default\` を指定してください。`)
        value = raw
      }
      await store.setReplyModel(guildID, name, value)
      return say(`変更しました。次のメンションから反映されます。\n${await show()}`)
    } catch (e) {
      global.logger.warn(`Could not change the reply model of ${guildID}: ${e.message}`)
      return say('設定を変えられませんでした。')
    }
  },
  replyModels,
  name: 'replymodel',
  description: 'Bot owner debug command.',
  type: 'creator',
  noDM: true,
  hidden: true
}
