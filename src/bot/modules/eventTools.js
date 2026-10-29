const urlFetcher = require('../utils/urlFetcher')
const { describeForums } = require('./forumPost')

const MAX_RECENT_MESSAGES = 50
const MAX_QUESTIONS = 3
const MAX_OPTIONS = 4
const MAX_RESULT_CHARS = 20000
const MESSAGE_LINK = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i

// Tools the model can call while drafting. All are read-only and scoped to what the requesting
// member could see themselves, so a mention can't be used to read channels they have no access to.
const DECLARATIONS = [
  {
    name: 'fetch_url',
    description: 'Web ページの本文・タイトル・メタ情報・JSON-LD をテキストで取得する。Discord のメッセージリンクには使わず get_discord_message を使う。',
    parameters: { type: 'OBJECT', properties: { url: { type: 'STRING' } }, required: ['url'] }
  },
  {
    name: 'get_discord_message',
    description: 'このサーバーの Discord メッセージリンク（https://discord.com/channels/サーバーID/チャンネルID/メッセージID）が指すメッセージを読む。',
    parameters: { type: 'OBJECT', properties: { link: { type: 'STRING' } }, required: ['link'] }
  },
  {
    name: 'get_recent_messages',
    description: 'このサーバーのチャンネルの最近のメッセージを新しい順に読む。依頼が「このチャンネルで話していた内容」などを指すときに使う。',
    parameters: {
      type: 'OBJECT',
      properties: {
        channel_id: { type: 'STRING' },
        limit: { type: 'INTEGER', description: `1〜${MAX_RECENT_MESSAGES}` }
      },
      required: ['channel_id']
    }
  },
  {
    name: 'list_channels',
    description: 'このサーバーで依頼者が閲覧できるチャンネルの一覧（ID・名前・種類）を得る。ボイス/ステージでイベントを行う場合のチャンネル選びにも使う。',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'list_forums',
    description: '依頼者とBOTの両方が投稿できるフォーラムチャンネルの一覧（ID・名前・付けられるタグ・投稿ガイドライン）を得る。フォーラムへの投稿を頼まれたら必ず使う。',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'ask_user',
    description: `候補が複数ある・日時や場所が曖昧など、依頼者に決めてもらう必要があるときに、選択肢をボタンで提示して1つ選んでもらう。選択肢は2〜${MAX_OPTIONS}個の短い文。自由記述が必要な質問には使わない。`,
    parameters: {
      type: 'OBJECT',
      properties: {
        question: { type: 'STRING' },
        options: { type: 'ARRAY', items: { type: 'STRING' } }
      },
      required: ['question', 'options']
    }
  },
  {
    name: 'list_scheduled_events',
    description: 'このサーバーに登録済みのスケジュールイベントの一覧を得る。同じイベントの重複登録を避けるために使う。',
    parameters: { type: 'OBJECT', properties: {} }
  }
]

const CHANNEL_TYPES = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum', 16: 'media', 10: 'thread', 11: 'thread', 12: 'thread' }

function canRead (channel, userID) {
  const perms = channel?.permissionsOf?.(userID)
  return !!perms && perms.has('viewChannel') && perms.has('readMessageHistory')
}

function formatMessage (m) {
  const lines = [`[${new Date(m.timestamp).toISOString()}] ${m.author.username} (${m.author.id}): ${m.content || ''}`]
  for (const e of m.embeds || []) {
    const text = [e.title, e.description, ...(e.fields || []).map(f => `${f.name}: ${f.value}`), e.url].filter(Boolean).join('\n')
    if (text) lines.push(`  埋め込み: ${text}`)
  }
  for (const a of m.attachments || []) lines.push(`  添付: ${a.filename} ${a.url}`)
  return lines.join('\n')
}

// Thrown to end the whole draft (the requester cancelled or stopped answering). Unlike a tool error
// it is not handed back to the model.
class StopDrafting extends Error {}

function createTools ({ guild, member, ask }) {
  const sources = []
  let questions = 0

  function readableChannel (channelID) {
    const channel = global.bot.getChannel(channelID)
    if (!channel || channel.guild?.id !== guild.id) throw new Error('このサーバーのチャンネルではありません')
    if (!canRead(channel, member.id)) throw new Error('依頼者がこのチャンネルのメッセージを閲覧できません')
    if (!canRead(channel, global.bot.user.id)) throw new Error('BOTがこのチャンネルのメッセージを閲覧できません')
    return channel
  }

  async function readMessage (channelID, messageID) {
    readableChannel(channelID)
    return formatMessage(await global.bot.getMessage(channelID, messageID))
  }

  const executors = {
    async fetch_url ({ url }) {
      if (MESSAGE_LINK.test(url)) return executors.get_discord_message({ link: url })
      const page = await urlFetcher.fetchPageText(url)
      sources.push(page.url)
      return page.text
    },
    async get_discord_message ({ link }) {
      const match = String(link).match(MESSAGE_LINK)
      if (!match) throw new Error('Discord のメッセージリンクではありません')
      if (match[1] !== guild.id) throw new Error('別のサーバーのメッセージは読めません')
      const text = await readMessage(match[2], match[3])
      sources.push(match[0])
      return text
    },
    async get_recent_messages ({ channel_id: channelID, limit }) {
      const channel = readableChannel(channelID)
      const count = Math.min(Math.max(parseInt(limit, 10) || 20, 1), MAX_RECENT_MESSAGES)
      const messages = await global.bot.getMessages(channelID, { limit: count })
      sources.push(`<#${channel.id}>`)
      return messages.map(formatMessage).join('\n')
    },
    async list_channels () {
      return [...guild.channels.values()]
        .filter(c => c.permissionsOf(member.id).has('viewChannel'))
        .map(c => `${c.id}: ${c.name}（${CHANNEL_TYPES[c.type] || c.type}）`)
        .join('\n')
    },
    async list_forums () {
      return describeForums(guild, member)
    },
    async ask_user ({ question, options }) {
      const choices = [...new Set((options || []).map(o => String(o).trim()).filter(Boolean))].slice(0, MAX_OPTIONS)
      if (!question || choices.length < 2) throw new Error(`question と2〜${MAX_OPTIONS}個の options が必要です`)
      if (questions >= MAX_QUESTIONS) throw new Error('これ以上依頼者に質問できません。分かっている情報で提出してください')
      questions++
      const answer = await ask(String(question), choices)
      return `依頼者の回答: ${answer}`
    },
    async list_scheduled_events () {
      const events = await global.bot.requestHandler.request('GET', `/guilds/${guild.id}/scheduled-events`, true)
      if (events.length === 0) return '登録済みのイベントはありません'
      return events.map(e => `${e.name}: ${e.scheduled_start_time}〜${e.scheduled_end_time || ''} ${e.entity_metadata?.location || (e.channel_id ? `<#${e.channel_id}>` : '')}`).join('\n')
    }
  }

  // Errors go back to the model as the tool result, so it can tell the user what it couldn't read
  // instead of the whole draft failing.
  async function call (name, args) {
    if (!executors[name]) return { error: `不明なツールです: ${name}` }
    try {
      const result = await executors[name](args || {})
      return { result: String(result).slice(0, MAX_RESULT_CHARS) }
    } catch (e) {
      if (e instanceof StopDrafting) throw e
      return { error: e.message }
    }
  }

  return { declarations: DECLARATIONS, call, sources, readMessage }
}

module.exports = { createTools, formatMessage, MESSAGE_LINK, StopDrafting }
