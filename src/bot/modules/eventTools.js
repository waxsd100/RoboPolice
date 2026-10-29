const urlFetcher = require('../utils/urlFetcher')
const { describeForums } = require('./forumPost')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const messageDB = require('../../db/interfaces/postgres/read')
const videoSummary = require('./videoSummary')

const MAX_RECENT_MESSAGES = 50
const MAX_QUESTIONS = 3
const MAX_OPTIONS = 4
const MAX_RESULT_CHARS = 20000
const MESSAGE_LINK = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i

// Tools the model can call while drafting. A tool without arguments has no `parameters` at all:
// Gemini rejects an OBJECT schema whose `properties` is empty, which failed every request.
// All are read-only and scoped to what the requesting
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
    name: 'summarize_youtube_video',
    description: '公開されている YouTube 動画の中身（話している内容）を要約する。動画のリンクが貼られたときや、動画の内容が必要なときだけ使う。一度要約した動画は保存済みの要約を返す。',
    parameters: { type: 'OBJECT', properties: { url: { type: 'STRING', description: 'YouTube 動画の URL' } }, required: ['url'] }
  },
  {
    name: 'search_channel_history',
    description: 'このサーバーのチャンネルについて、BOT が保存しているこれまでのメッセージを新しい順に読む（get_recent_messages より長い期間を見られる）。「このチャンネルの内容をもとに」「これまでの話をまとめて」のような依頼で使う。query を指定するとその語をすべて含むものに絞る。',
    parameters: {
      type: 'OBJECT',
      properties: {
        channel_id: { type: 'STRING' },
        query: { type: 'STRING', description: '本文に含まれる語（空白区切りで AND）。省略可' }
      },
      required: ['channel_id']
    }
  },
  {
    name: 'list_channels',
    description: 'このサーバーで依頼者が閲覧できるチャンネルの一覧（ID・名前・種類）を得る。ボイス/ステージでイベントを行う場合のチャンネル選びにも使う。'
  },
  {
    name: 'list_forums',
    description: '依頼者とBOTの両方が投稿できるフォーラムチャンネルの一覧（ID・名前・付けられるタグ・投稿ガイドライン）を得る。フォーラムへの投稿を頼まれたら必ず使う。'
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
    description: 'このサーバーに登録済みのスケジュールイベントの一覧を得る。同じイベントの重複登録を避けるために使う。'
  },
  {
    name: 'search_youtube',
    description: 'このサーバーに設定された YouTube チャンネルについて保存している情報（チャンネル概要、最近の動画、配信予定・配信中）を探す。動画・配信・チャンネルについての依頼で使う。query を省くと新しい順に返す。',
    parameters: {
      type: 'OBJECT',
      properties: { query: { type: 'STRING', description: '題名・説明に含まれる語（空白区切りで AND）' } }
    }
  }
]

// How much stored history one search reads, and how many matching messages it returns.
const HISTORY_SCAN = 1000
const MAX_HISTORY_RESULTS = 100
const MAX_HISTORY_TEXT = 500
const MAX_PROFILE_CHANNELS = 80
const MAX_PROFILE_ROLES = 40
const MAX_TOPIC = 100
const MAX_YOUTUBE_RESULTS = 15
const LIVE_LABELS = { live: '配信中', upcoming: '配信予定' }

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
    for (const image of [e.image, e.thumbnail].filter(i => i?.url)) lines.push(`  埋め込み画像: ${image.url}`)
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
    async search_channel_history ({ channel_id: channelID, query }) {
      const channel = readableChannel(channelID)
      const rows = await messageDB.getChannelHistory(channelID, HISTORY_SCAN)
      const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
      const matches = rows.filter(r => words.every(w => (r.content || '').toLowerCase().includes(w)))
      sources.push(`<#${channel.id}>`)
      if (rows.length === 0) return `<#${channel.id}> の保存済みメッセージはありません（保存しているのは削除・編集ログを設定したサーバーの、保持期間内のメッセージのみ）`
      const name = id => guild.members.get(id)?.username || id
      // Oldest first, like reading the channel.
      const lines = matches.slice(0, MAX_HISTORY_RESULTS).reverse()
        .map(r => `[${new Date(r.ts).toISOString()}] ${name(r.author_id)}: ${(r.content || '').replace(/\s+/g, ' ').slice(0, MAX_HISTORY_TEXT)}`)
      const oldest = new Date(rows[rows.length - 1].ts).toISOString()
      return [
        `<#${channel.id}> の保存済みメッセージ ${rows.length} 件（${oldest} 以降）${words.length ? `のうち「${query}」を含む ${matches.length} 件` : ''}、古い順:`,
        ...lines,
        ...(matches.length > MAX_HISTORY_RESULTS ? [`…ほか ${matches.length - MAX_HISTORY_RESULTS} 件（query で絞り込めます）`] : [])
      ].join('\n')
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
      return scheduledEvents(guild)
    },
    async search_youtube ({ query }) {
      return searchYouTube(guild.id, query)
    },
    async summarize_youtube_video ({ url }) {
      const { videoID, summary, cached } = await videoSummary.summarizeVideo(guild.id, url)
      const link = `https://www.youtube.com/watch?v=${videoID}`
      sources.push(link)
      return `${link} の内容の要約${cached ? '（保存済み）' : ''}:\n${summary}`
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

async function scheduledEvents (guild) {
  const events = await global.bot.requestHandler.request('GET', `/guilds/${guild.id}/scheduled-events`, true)
  if (events.length === 0) return '登録済みのイベントはありません'
  return events.map(e => `${e.name}: ${e.scheduled_start_time}〜${e.scheduled_end_time || ''} ${e.entity_metadata?.location || (e.channel_id ? `<#${e.channel_id}>` : '')}`).join('\n')
}

function formatVideo (v) {
  const live = LIVE_LABELS[v.live_status]
  const when = live && v.scheduled_start ? `${live} ${new Date(v.scheduled_start).toISOString()}` : live
  const published = v.published_at ? new Date(v.published_at).toISOString().slice(0, 10) : '?'
  const head = `- ${when ? `[${when}] ` : ''}${v.title}（公開 ${published}${v.duration ? `、長さ ${v.duration}` : ''}）${v.url}`
  const description = (v.description || '').replace(/\s+/g, ' ').slice(0, 200)
  const lines = [head]
  if (description) lines.push(`  ${description}`)
  if (v.summary) lines.push(`  内容の要約: ${v.summary.replace(/\s+/g, ' ').slice(0, 400)}`)
  return lines.join('\n')
}

const matchesAll = (words, text) => words.every(w => text.toLowerCase().includes(w))

async function searchYouTube (guildID, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  const knowledge = await youtubeDB.getKnowledge(guildID)
  // Summaries of linked videos from other channels are knowledge too.
  const others = (await youtubeDB.getOtherSummaries(guildID))
    .filter(s => matchesAll(words, s.summary))
    .map(s => `- https://www.youtube.com/watch?v=${s.video_id}\n  内容の要約: ${s.summary.replace(/\s+/g, ' ').slice(0, 400)}`)
  const otherLines = others.length ? ['', `その他の要約済み動画（${others.length} 件）:`, ...others.slice(0, MAX_YOUTUBE_RESULTS)] : []

  if (!knowledge) return ['このサーバーには YouTube チャンネルが設定されていません（運営が /youtube set で設定できます）', ...otherLines].join('\n')
  const { channel, videos } = knowledge
  if (!channel.synced_at) return [`YouTube チャンネル ${channel.channel_ref} は設定済みですが、まだ情報を取得していません（/youtube sync）`, ...otherLines].join('\n')
  const matches = videos.filter(v => matchesAll(words, `${v.title}\n${v.description || ''}\n${v.summary || ''}`))
  // Lives first: "the next stream" is the usual question.
  const ordered = [...matches.filter(v => LIVE_LABELS[v.live_status]), ...matches.filter(v => !LIVE_LABELS[v.live_status])]
  return [
    `チャンネル: ${channel.title}（${channel.url}）`,
    channel.description ? `概要: ${channel.description.replace(/\s+/g, ' ').slice(0, 300)}` : '',
    `情報の取得日時: ${new Date(channel.synced_at).toISOString()}（保存している動画 ${videos.length} 件、うち内容の要約あり ${videos.filter(v => v.summary).length} 件）`,
    words.length ? `「${query}」に一致した動画: ${matches.length} 件` : '新しい順の動画:',
    ...ordered.slice(0, MAX_YOUTUBE_RESULTS).map(formatVideo),
    ...(matches.length > MAX_YOUTUBE_RESULTS ? [`…ほか ${matches.length - MAX_YOUTUBE_RESULTS} 件（query で絞り込めます）`] : []),
    ...otherLines
  ].filter(Boolean).join('\n')
}

function channelLine (c, requestChannelID) {
  const topic = c.topic ? ` — ${c.topic.replace(/\s+/g, ' ').slice(0, MAX_TOPIC)}` : ''
  return `- ${c.id}: #${c.name}（${CHANNEL_TYPES[c.type] || c.type}）${c.id === requestChannelID ? ' ← 依頼されたチャンネル' : ''}${topic}`
}

// The server as the requester can see it. Sent with every request, fresh each time, so questions
// about "this server" need no lookups.
async function describeServer (guild, member, requestChannelID) {
  const lines = [`サーバー名: ${guild.name}`]
  if (guild.description) lines.push(`説明: ${guild.description}`)
  if (guild.memberCount) lines.push(`メンバー数: ${guild.memberCount}`)
  if (guild.rulesChannelID) lines.push(`ルールチャンネル: <#${guild.rulesChannelID}>`)

  const all = [...guild.channels.values()]
  const order = c => [guild.channels.get(c.parentID)?.position ?? -1, c.position ?? 0]
  const visible = all
    .filter(c => c.type !== 4 && c.permissionsOf(member.id).has('viewChannel'))
    .sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1])
  const byCategory = new Map()
  for (const c of visible.slice(0, MAX_PROFILE_CHANNELS)) {
    const category = guild.channels.get(c.parentID)?.name || '（カテゴリなし）'
    if (!byCategory.has(category)) byCategory.set(category, [])
    byCategory.get(category).push(channelLine(c, requestChannelID))
  }
  lines.push('', '### チャンネル（依頼者が見られるもの）')
  for (const [category, channels] of byCategory) lines.push(`[${category}]`, ...channels)
  if (visible.length > MAX_PROFILE_CHANNELS) lines.push(`…ほか ${visible.length - MAX_PROFILE_CHANNELS} 件`)

  const roles = [...guild.roles.values()]
    .filter(r => r.id !== guild.id && !r.managed)
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
    .map(r => r.name)
  if (roles.length) lines.push('', '### ロール', roles.slice(0, MAX_PROFILE_ROLES).join(', '))

  lines.push('', '### 登録済みのイベント', await scheduledEvents(guild).catch(e => `（取得できませんでした: ${e.message}）`))

  const youtube = await youtubeDB.getKnowledge(guild.id).catch(() => null)
  lines.push('', '### YouTube', youtube?.channel.synced_at
    ? `${youtube.channel.title}（動画 ${youtube.videos.length} 件を保存、取得 ${new Date(youtube.channel.synced_at).toISOString()}）。詳しくは search_youtube で調べる`
    : '設定なし')
  return lines.join('\n')
}

module.exports = { createTools, formatMessage, describeServer, searchYouTube, MESSAGE_LINK, StopDrafting }
