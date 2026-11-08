// %embeddings: per-server toggles for vectorizing messages (embeddingIndexer.js) and
// describing/vectorizing custom emojis (emojiDescriber.js). For the bot's developers (CREATOR_IDS):
// embeddings use AI calls and database disk space.
//   %embeddings                         shows current settings
//   %embeddings on | off | default      sets both messages and emojis
//   %embeddings messages on|off|default sets message embeddings
//   %embeddings emojis on|off|default   sets emoji descriptions & embeddings
const store = require('../../db/interfaces/postgres/replySettings')
const emojiDescriber = require('../modules/emojiDescriber')
const { isOwnerGuild } = require('../utils/priority')

const TARGETS = {
  messages: 'messages',
  message: 'messages',
  emojis: 'emojis',
  emoji: 'emojis',
  all: 'all'
}

function formatLine (label, effective, explicit, owner) {
  const state = effective ? 'オン' : 'オフ'
  const source = explicit === null || explicit === undefined
    ? `（既定：${owner ? 'オーナーサーバーのためオン' : 'オフ'}）`
    : '（このサーバーの設定）'
  return `- ${label}: ${state}${source}`
}

function describe (guildID, { embeddings = {}, embedMessages, embedEmojis }) {
  const owner = isOwnerGuild(guildID)
  const prefix = process.env.GLOBAL_BOT_PREFIX
  return [
    'このサーバーのベクトル化（Embedding）設定:',
    formatLine('メッセージのベクトル化 (`messages`)', embedMessages, embeddings.messages, owner),
    formatLine('絵文字の説明・ベクトル化 (`emojis`)', embedEmojis, embeddings.emojis, owner),
    `\`${prefix}embeddings [messages|emojis] <on|off|default>\` で切り替えられます（対象省略時は両方まとめて変更）。`,
    '（オフにしても既に保存済みのベクトルデータは残ります）'
  ].join('\n')
}

module.exports = {
  func: async (message, suffix) => {
    const guild = message.channel.guild
    const guildID = guild.id
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
      if (!target || !['on', 'off', 'default'].includes(raw)) {
        return say(`\`messages\` / \`emojis\`（または省略）と \`on\`・\`off\`・\`default\` を指定してください。\n${await show()}`)
      }
      const value = raw === 'default' ? null : raw === 'on'
      await store.setEmbedding(guildID, target, value)
      const updated = await store.getReplySettings(guildID)
      if ((target === 'emojis' || target === 'all') && updated.embedEmojis) {
        emojiDescriber.schedule(guild)
      }
      return say(`変更しました。\n${describe(guildID, updated)}`)
    } catch (e) {
      global.logger.warn(`Could not change the embedding settings of ${guildID}: ${e.message}`)
      return say('設定を変えられませんでした。')
    }
  },
  name: 'embeddings',
  description: 'Bot owner debug command.',
  type: 'creator',
  noDM: true,
  hidden: true
}
