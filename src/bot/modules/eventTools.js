const urlFetcher = require('../utils/urlFetcher')
const { describeForums } = require('./forumPost')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const messageDB = require('../../db/interfaces/postgres/read')
const videoSummary = require('./videoSummary')
const { linkTimestamps } = require('../utils/youtube')
const emojiDescriber = require('./emojiDescriber')
const wikiKnowledge = require('./wikiKnowledge')
const gameMentions = require('./gameMentions')
const gameLinks = require('./gameLinks')
const emojiStore = require('../../db/interfaces/postgres/emojis')
const { embedQuery, model: embeddingModel } = require('../utils/embeddings')
const { fromStoredContent } = require('../../db/interfaces/postgres/create')
const semanticSearch = require('./semanticSearch')
const { messageEmbeddingsEnabled } = require('./embeddingIndexer')

const MAX_RECENT_MESSAGES = 50
const MAX_QUESTIONS = 3
const MAX_OPTIONS = 4
const MAX_RESULT_CHARS = 20000
const MESSAGE_LINK = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i

// Tools the model can call while drafting. A tool without arguments has no `parameters` at all:
// Gemini rejects an OBJECT schema whose `properties` is empty, which failed every request.
// All are read-only and scoped to what the requesting
// member could see themselves, so a mention can't be used to read channels they have no access to.
// Offered only when every stored message is embedded (MESSAGE_EMBEDDINGS=true).
const SEARCH_SERVER_MESSAGES = {
  name: 'search_server_messages',
  description: 'このサーバーで依頼者が読めるすべてのチャンネルの保存済みメッセージから、query と意味が近いものを探す（言い回しが違っても見つかる）。どのチャンネルの話か分からないときや、サーバー全体の話題を調べるときに使う。',
  parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: '探したい内容（文章でよい）' } }, required: ['query'] }
}

const FIND_GAME = {
  name: 'find_game',
  description: 'ゲームの Discord のゲームメンション（返事に書くとゲームのプロフィールが表示される）と、ストアページ（Steam）または公式ページを調べる。返事やイベントの説明で特定のゲームに触れるときに使う。',
  parameters: {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING', description: 'ゲームの正式な名前' },
      name_en: { type: 'STRING', description: '英語の正式名（分かれば）' }
    },
    required: ['name']
  }
}

const SEARCH_WIKI = {
  name: 'search_wiki',
  description: 'コミュニティの wiki（配信者のキャラクター・名言・台詞・ネタ・用語・基本情報など）から、query と意味が近い記述を探す。キャラクターや名言・ネタについての話題、配信者らしい言い回しを知りたいときに使う。',
  parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: '探したい内容（キャラクター名、名言の一部、話題など）' } }, required: ['query'] }
}

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
    description: 'このサーバーのチャンネルについて、BOT が保存しているこれまでのメッセージを新しい順に読む（get_recent_messages より長い期間を見られる）。「このチャンネルの内容をもとに」「これまでの話をまとめて」のような依頼で使う。query を指定するとその語をすべて含むもの（メッセージの意味検索が有効なら、意味が近いもの）に絞る。',
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
const MAX_PROFILE_EMOJIS = 60
const MAX_YOUTUBE_RESULTS = 15
const LIVE_LABELS = { live: '配信中', upcoming: '配信予定' }

const CHANNEL_TYPES = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum', 16: 'media', 10: 'thread', 11: 'thread', 12: 'thread' }

function canRead (channel, userID) {
  const perms = channel?.permissionsOf?.(userID)
  return !!perms && perms.has('viewChannel') && perms.has('readMessageHistory')
}

// How many messages a reply chain is followed back, for a conversation with the bot.
const MAX_THREAD = 10

// Who wrote a message. In a conversation (a reply chain, given `requesterID`) the bot's own earlier
// replies read "あなた（BOT）" and the requester is marked, so the model can follow who said what.
function authorLabel (author, requesterID) {
  if (requesterID && author.id === global.bot.user.id) return 'あなた（BOT）'
  return `${author.username} (${author.id})${requesterID && author.id === requesterID ? '（依頼者）' : ''}`
}

function formatMessage (m, requesterID = null) {
  const lines = [`[${new Date(m.timestamp).toISOString()}] ${authorLabel(m.author, requesterID)}: ${m.content || ''}`]
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

// progress(text): shows the requester what a slow tool is doing. Optional.
function createTools ({ guild, member, ask, progress = () => {} }) {
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

  // The replied-to message and the replies it continues, oldest first: the conversation the
  // mention is part of. Stops at the start of the chain, a deleted message, or MAX_THREAD.
  async function readThread (channelID, messageID) {
    const messages = []
    let next = { channelID, messageID }
    while (next?.messageID && messages.length < MAX_THREAD) {
      readableChannel(next.channelID)
      const m = await global.bot.getMessage(next.channelID, next.messageID).catch(e => {
        if (messages.length === 0) throw e
        return null
      })
      if (!m) break
      messages.unshift(m)
      next = m.messageReference && { channelID: m.messageReference.channelID || next.channelID, messageID: m.messageReference.messageID }
    }
    return { text: messages.map(m => formatMessage(m, member.id)).join('\n'), count: messages.length }
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
      return messages.map(m => formatMessage(m)).join('\n')
    },
    async search_channel_history ({ channel_id: channelID, query }) {
      const channel = readableChannel(channelID)
      // Stored text is escaped for log embeds; search and show what people actually wrote.
      const rows = (await messageDB.getChannelHistory(channelID, HISTORY_SCAN))
        .map(r => ({ ...r, content: fromStoredContent(r.content) }))
        .filter(r => r.content)
      const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
      const matches = rows.filter(r => words.every(w => (r.content || '').toLowerCase().includes(w)))
      sources.push(`<#${channel.id}>`)
      if (rows.length === 0) return `<#${channel.id}> の保存済みメッセージはありません（保存しているのは削除・編集ログを設定したサーバーの、保持期間内のメッセージのみ）`
      const name = id => guild.members.get(id)?.username || id
      if (words.length && messageEmbeddingsEnabled()) {
        const close = await semanticSearch.searchMessages(guild.id, [channel.id], query, { limit: MAX_HISTORY_RESULTS }).catch(e => {
          global.logger.warn(`Semantic message search failed, using keywords: ${e.message}`)
          return null
        })
        if (close) {
          // Messages too new to be embedded yet are found by their words.
          const found = new Set(close.map(m => m.id))
          const recent = matches.filter(r => !found.has(r.id)).slice(0, 10)
          return [
            `<#${channel.id}> の保存済みメッセージから「${query}」に意味が近いもの（近い順）:`,
            ...close.map(r => `[${new Date(r.ts).toISOString()}] ${name(r.author_id)}: ${(r.content || '').replace(/\s+/g, ' ').slice(0, MAX_HISTORY_TEXT)}`),
            ...(recent.length ? ['', '語を含む最近のメッセージ:', ...recent.map(r => `[${new Date(r.ts).toISOString()}] ${name(r.author_id)}: ${(r.content || '').replace(/\s+/g, ' ').slice(0, MAX_HISTORY_TEXT)}`)] : [])
          ].join('\n')
        }
      }
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
    async search_server_messages ({ query }) {
      if (!String(query || '').trim()) throw new Error('query を指定してください')
      const channels = [...guild.channels.values()].filter(c => canRead(c, member.id) && canRead(c, global.bot.user.id))
      const found = await semanticSearch.searchMessages(guild.id, channels.map(c => c.id), String(query), { limit: MAX_HISTORY_RESULTS })
      const name = id => guild.members.get(id)?.username || id
      if (found.length === 0) return '意味の近いメッセージは見つかりませんでした（メッセージの埋め込みがまだ作られていない可能性があります）'
      for (const id of new Set(found.map(m => m.channel_id))) sources.push(`<#${id}>`)
      return [
        `「${query}」に意味が近いメッセージ（近い順、依頼者が読めるチャンネルのみ）:`,
        ...found.map(r => `[${new Date(r.ts).toISOString()}] <#${r.channel_id}> ${name(r.author_id)}: ${(r.content || '').replace(/\s+/g, ' ').slice(0, MAX_HISTORY_TEXT)}`)
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
    async find_game ({ name, name_en: nameEn }) {
      const names = [name, nameEn].map(n => String(n || '').trim()).filter(Boolean)
      if (!names.length) throw new Error('name が必要です')
      const [game, links] = await Promise.all([
        gameMentions.findGame(names).catch(() => null),
        gameLinks.linksFor([{ name: names[0], nameEn: names[1] || null }]).catch(() => [])
      ])
      const lines = []
      if (game) lines.push(`Discord のゲームメンション: ${game.mention}（${game.name}。返事にこの書き方のまま書くと、ゲームのプロフィールが表示される）`)
      if (links[0]) lines.push(`ページ: ${links[0].url}`)
      return lines.length ? lines.join('\n') : `「${names[0]}」は Discord のゲーム一覧にもストアにも見つかりませんでした`
    },
    async search_wiki ({ query }) {
      return wikiKnowledge.searchWiki(String(query || ''))
    },
    async summarize_youtube_video ({ url }) {
      const { videoID, summary, cached } = await videoSummary.summarizeVideo(guild.id, url, {
        onStart: timeoutMs => progress(`動画の内容を読み取っています…（長い動画は数分かかります。最大 ${Math.round(timeoutMs / 60000)} 分）`)
      })
      const link = `https://www.youtube.com/watch?v=${videoID}`
      sources.push(link)
      return `${link} の内容の要約${cached ? '（保存済み）' : ''}:\n${linkTimestamps(summary, videoID)}`
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

  const declarations = [...DECLARATIONS, FIND_GAME, ...(messageEmbeddingsEnabled() ? [SEARCH_SERVER_MESSAGES] : []), ...(wikiKnowledge.enabled() ? [SEARCH_WIKI] : [])]
  return { declarations, call, sources, readMessage, readThread }
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
  if (v.summary) lines.push(`  内容の要約: ${linkTimestamps(v.summary.replace(/\s+/g, ' ').slice(0, 400), v.video_id)}`)
  return lines.join('\n')
}

const matchesAll = (words, text) => words.every(w => text.toLowerCase().includes(w))

async function searchYouTube (guildID, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  const knowledge = await youtubeDB.getKnowledge(guildID)
  // Summaries of linked videos from other channels are knowledge too.
  const others = (await youtubeDB.getOtherSummaries(guildID))
    .filter(s => matchesAll(words, s.summary))
    .map(s => `- https://www.youtube.com/watch?v=${s.video_id}\n  内容の要約: ${linkTimestamps(s.summary.replace(/\s+/g, ' ').slice(0, 400), s.video_id)}`)
  const otherLines = others.length ? ['', `その他の要約済み動画（${others.length} 件）:`, ...others.slice(0, MAX_YOUTUBE_RESULTS)] : []

  if (!knowledge) return ['このサーバーには YouTube チャンネルが設定されていません（運営が /youtube set で設定できます）', ...otherLines].join('\n')
  const { channel, videos } = knowledge
  if (!channel.synced_at) return [`YouTube チャンネル ${channel.channel_ref} は設定済みですが、まだ情報を取得していません（/youtube sync）`, ...otherLines].join('\n')
  const matches = videos.filter(v => matchesAll(words, `${v.title}\n${v.description || ''}\n${v.summary || ''}`))
  // By meaning when embeddings exist, so different wording still finds the video.
  const ranked = words.length
    ? await semanticSearch.rankVideos(guildID, videos, query).catch(e => {
      global.logger.warn(`Semantic YouTube search failed, using keywords: ${e.message}`)
      return null
    })
    : null
  // Otherwise lives first: "the next stream" is the usual question.
  const ordered = ranked || [...matches.filter(v => LIVE_LABELS[v.live_status]), ...matches.filter(v => !LIVE_LABELS[v.live_status])]
  return [
    `チャンネル: ${channel.title}（${channel.url}）`,
    channel.description ? `概要: ${channel.description.replace(/\s+/g, ' ').slice(0, 300)}` : '',
    `情報の取得日時: ${new Date(channel.synced_at).toISOString()}（保存している動画 ${videos.length} 件、うち内容の要約あり ${videos.filter(v => v.summary).length} 件）`,
    ranked
      ? `「${query}」に意味が近い順の動画（語をすべて含むもの ${matches.length} 件を優先）:`
      : words.length ? `「${query}」に一致した動画: ${matches.length} 件` : '新しい順の動画:',
    ...ordered.slice(0, MAX_YOUTUBE_RESULTS).map(formatVideo),
    ...(!ranked && matches.length > MAX_YOUTUBE_RESULTS ? [`…ほか ${matches.length - MAX_YOUTUBE_RESULTS} 件（query で絞り込めます）`] : []),
    ...otherLines
  ].filter(Boolean).join('\n')
}

function channelLine (c, requestChannelID) {
  const topic = c.topic ? ` — ${c.topic.replace(/\s+/g, ' ').slice(0, MAX_TOPIC)}` : ''
  return `- ${c.id}: #${c.name}（${CHANNEL_TYPES[c.type] || c.type}）${c.id === requestChannelID ? ' ← 依頼されたチャンネル' : ''}${topic}`
}

const { usableEmojis } = emojiDescriber

function emojiCode (e) {
  return `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`
}

// The model sometimes writes a server emoji as :name: rather than its code; Discord shows that as
// plain text, so it is turned into the code when the server has such an emoji.
function withServerEmojis (text, guild) {
  const byName = new Map(usableEmojis(guild).map(e => [e.name, e]))
  return text.replace(/(<a?)?:(\w{2,32}):(\d+>)?/g, (whole, open, name, close) => {
    if (open || close) return whole
    const emoji = byName.get(name)
    return emoji ? emojiCode(emoji) : whole
  })
}

// The server's emojis for the model. With descriptions (emojiDescriber.js), one per line with what
// it shows and when to use it, those closest in meaning to `query` first; otherwise just the codes.
async function emojiSection (guild, query) {
  const emojis = usableEmojis(guild)
  if (!emojis.length) return []
  const head = '### サーバー絵文字（返事で使うときは、この書き方のまま書く）'
  const notes = emojiDescriber.enabled() ? await emojiStore.descriptions(guild.id).catch(() => ({})) : {}
  if (!Object.keys(notes).length) return [head, emojis.slice(0, MAX_PROFILE_EMOJIS).map(emojiCode).join(' ')]
  let first = []
  if (query) {
    first = await embedQuery(query)
      .then(q => emojiStore.nearestEmojis(guild.id, q, embeddingModel(), MAX_PROFILE_EMOJIS))
      .catch(e => {
        global.logger.warn(`Could not rank the emojis of ${guild.id}: ${e.message}`)
        return []
      })
  }
  const rank = new Map(first.map((id, i) => [id, i]))
  const ordered = [...emojis].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
  return [
    `${head}。話に合いそうな順:`,
    ...ordered.slice(0, MAX_PROFILE_EMOJIS).map(e => notes[e.id] ? `- ${emojiCode(e)} ${notes[e.id]}` : `- ${emojiCode(e)}`)
  ]
}

// The server as the requester can see it. Sent with every request, fresh each time, so questions
// about "this server" need no lookups. query: what was asked, to put the emojis that suit it first.
async function describeServer (guild, member, requestChannelID, { query = '' } = {}) {
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

  const emojiLines = await emojiSection(guild, query)
  if (emojiLines.length) lines.push('', ...emojiLines)

  lines.push('', '### 登録済みのイベント', await scheduledEvents(guild).catch(e => `（取得できませんでした: ${e.message}）`))

  const youtube = await youtubeDB.getOverview(guild.id).catch(() => null)
  lines.push('', '### YouTube', youtube?.synced_at
    ? [
        `${youtube.title}（動画 ${youtube.video_count} 件を保存、取得 ${new Date(youtube.synced_at).toISOString()}）。詳しくは search_youtube で調べる`,
        ...(youtube.description ? [`チャンネルの説明: ${youtube.description.replace(/\s+/g, ' ').slice(0, 300)}`] : [])
      ].join('\n')
    : '設定なし')
  return lines.join('\n')
}

module.exports = { createTools, formatMessage, describeServer, withServerEmojis, searchYouTube, MESSAGE_LINK, StopDrafting }
