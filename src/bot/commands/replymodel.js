// %replymodel: the model, thinking level, and inference tier AI tasks use in this server (eventDrafter.js).
// For the bot's developers (CREATOR_IDS): a dearer model is what the bot's owner pays for (it also
// uses up the members' token limits faster, mentionQuota.costOf).
//   %replymodel                                shows all task settings
//   %replymodel model gemini-4-argon           sets reply model (one of REPLY_MODELS, utils/replyOptions.js)
//   %replymodel thinking low                   sets reply thinking level (minimal, low, medium, high)
//   %replymodel tier flex                      sets reply inference tier (standard, flex)
//   %replymodel model default                  resets reply model to default (likewise thinking, tier)
//   %replymodel <task> model|thinking|tier <v> sets model/thinking/tier for a specific task
//   %replymodel <task> default                 resets all settings for <task> to default
// The stronger model a reply can hand over to (think_deeper, GEMINI_DEEP_MODEL) is not changed, and
// when the bot is busy (geminiLoad.js) the thinking level is still lowered.
const store = require('../../db/interfaces/postgres/replySettings')
const { defaultTaskConfig } = require('../modules/eventDrafter')
const { REPLY_MODELS, THINKING_LEVELS, SERVICE_TIERS, AI_TASKS, AI_TASK_LABELS } = require('../utils/replyOptions')

// The models a reply can be written with: the database's enum (replyOptions.js).
function replyModels () {
  return [...REPLY_MODELS]
}

function formatTaskLine (task, override = {}) {
  const def = defaultTaskConfig(task)
  const model = `${override.model || def.model}${override.model ? '（設定）' : '（既定）'}`
  const thinking = `${override.thinking || def.thinking}${override.thinking ? '（設定）' : '（既定）'}`
  const tier = `${override.tier || def.tier}${override.tier ? '（設定）' : '（既定）'}`
  return `- \`${task}\`（${AI_TASK_LABELS[task]}）: ${model} / 思考:${thinking} / ティア:${tier}`
}

function describe ({ replyModel, replyThinking, aiModels = {} }) {
  const defReply = defaultTaskConfig('reply')
  const rModel = aiModels?.reply?.model || replyModel
  const rThinking = aiModels?.reply?.thinking || replyThinking
  const rTier = aiModels?.reply?.tier || null
  const prefix = process.env.GLOBAL_BOT_PREFIX
  return [
    'このサーバーのメンションの返事:',
    `- モデル: ${rModel || defReply.model}${rModel ? '（このサーバーの設定）' : '（既定）'}`,
    `- 思考の深さ: ${rThinking || defReply.thinking}${rThinking ? '（このサーバーの設定）' : '（既定）'}`,
    `- 推論ティア: ${rTier || defReply.tier}${rTier ? '（このサーバーの設定）' : '（既定）'}`,
    '',
    '用途別のAIモデル設定:',
    ...AI_TASKS.map(t => formatTaskLine(t, t === 'reply' ? { model: rModel, thinking: rThinking, tier: rTier } : aiModels?.[t])),
    '',
    `\`${prefix}replymodel [用途] model <モデル>\` / \`thinking <${THINKING_LEVELS.join('|')}>\`` +
      ` / \`tier <${SERVICE_TIERS.join('|')}>\` / \`default\` で変えられます（用途省略時は \`reply\`）。`,
    `用途: ${AI_TASKS.map(t => `\`${t}\``).join('、')}`,
    `使えるモデル: ${replyModels().map(m => `\`${m}\``).join('、')}`,
    '（強いモデルに任せるとき（think_deeper）のモデルは変わりません。混み合っているときは思考の深さが下がります）'
  ].join('\n')
}

module.exports = {
  func: async (message, suffix) => {
    const guildID = message.channel.guild.id
    const say = content => message.channel.createMessage({ content, messageReference: { messageID: message.id } })
    const tokens = String(suffix || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    try {
      const show = async () => describe(await store.getReplySettings(guildID))
      if (!tokens.length) return say(await show())
      let task = 'reply'
      let rest = tokens
      if (AI_TASKS.includes(tokens[0])) {
        task = tokens[0]
        rest = tokens.slice(1)
      }
      const [name, raw] = rest
      if (name === 'default' && !raw) {
        await store.setTaskModel(guildID, task, 'all', null)
        return say(`\`${task}\`（${AI_TASK_LABELS[task]}）を既定に戻しました。\n${await show()}`)
      }
      if (!['model', 'thinking', 'tier'].includes(name)) {
        return say(`\`model\` か \`thinking\` を指定してください（\`tier\` や用途名 ${AI_TASKS.map(t => `\`${t}\``).join('・')} も指定できます）。\n${await show()}`)
      }
      let value = null
      if (raw !== 'default') {
        const allowed = name === 'model' ? replyModels() : (name === 'thinking' ? THINKING_LEVELS : SERVICE_TIERS)
        if (!allowed.includes(raw)) return say(`${allowed.map(v => `\`${v}\``).join('・')} か \`default\` を指定してください。`)
        value = raw
      }
      await store.setTaskModel(guildID, task, name, value)
      return say(`変更しました。次の実行から反映されます。\n${await show()}`)
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
