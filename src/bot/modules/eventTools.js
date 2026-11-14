const urlFetcher = require('../utils/urlFetcher')
const { describeForums } = require('./forumPost')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const twitchDB = require('../../db/interfaces/postgres/twitch')
const steamDB = require('../../db/interfaces/postgres/steam')
const messageDB = require('../../db/interfaces/postgres/read')
const videoSummary = require('./videoSummary')
const { linkTimestamps, parseVideoId, parseVideoIds, fetchVideos, formatDuration, formatCount, formatJstDate, formatJstIso } = require('../utils/youtube')
const emojiDescriber = require('./emojiDescriber')
const wikiKnowledge = require('./wikiKnowledge')
const gameMentions = require('./gameMentions')
const gameLinks = require('./gameLinks')
const emojiStore = require('../../db/interfaces/postgres/emojis')
const { embed, embedQuery, blend, model: embeddingModel } = require('../utils/embeddings')
const { fromStoredContent } = require('../../db/interfaces/postgres/create')
const semanticSearch = require('./semanticSearch')
const { messageEmbeddingsEnabled } = require('./embeddingIndexer')
const { wrap, reportInjectionAsync } = require('../utils/untrusted')
const serverLore = require('./serverLore')
const serverRules = require('./serverRules')
const loreStore = require('../../db/interfaces/postgres/serverLore')
const embeddingStore = require('../../db/interfaces/postgres/embeddings')
const { embeddableText } = require('../utils/messageNoise')
const { ownerGuildIDs } = require('../utils/priority')

const MAX_RECENT_MESSAGES = 50
const MAX_QUESTIONS = 3
const MAX_OPTIONS = 4
const MAX_RESULT_CHARS = 10000
const MESSAGE_LINK = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i
// A link to a channel itself (no message).
const CHANNEL_LINK = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/?(?:[?#]|$)/i

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

const ABOUT_MEMBER = {
  name: 'about_member',
  description: 'このサーバーのメンバーについて聞かれたときに使う。名前・ニックネーム・メンション（<@数字>）・ID でメンバーを探し、表示名・ロール・参加日と、（設定されていれば）依頼者が読めるチャンネルでの最近の発言を返す（その場で読むだけで保存しない）。',
  parameters: { type: 'OBJECT', properties: { member: { type: 'STRING', description: '名前・ニックネーム・<@ID>・ID のどれか' } }, required: ['member'] }
}
const MAX_MEMBER_MESSAGES = 30
const MAX_MEMBER_MATCHES = 5

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
  description: 'コミュニティの wiki（配信者のキャラクター・名言・台詞・ネタ・用語・基本情報など）と配信者本人の X（Twitter）のポストから、query と意味が近い記述を探す。キャラクターや名言・ネタ、配信者の最近の発言や告知について知りたいとき、配信者らしい言い回しを知りたいときに使う。',
  parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: '探したい内容（キャラクター名、名言の一部、話題など）' } }, required: ['query'] }
}

const DECLARATIONS = [
  {
    name: 'fetch_url',
    description: 'Web ページの本文・タイトル・メタ情報・JSON-LD をテキストで取得する（YouTube 動画の URL なら正確な題名・公開日時・再生数・概要欄なども取得する）。Discord のメッセージリンクには使わず get_discord_message を使う。',
    parameters: { type: 'OBJECT', properties: { url: { type: 'STRING' } }, required: ['url'] }
  },
  {
    name: 'get_discord_message',
    description: 'このサーバーの Discord メッセージリンク（https://discord.com/channels/サーバーID/チャンネルID/メッセージID）が指すメッセージを読む。チャンネルへのリンク（…/サーバーID/チャンネルID）なら、そのチャンネルの最近のメッセージを読む。',
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
    description: '公開されている YouTube 動画の中身（話している内容）を要約する。動画のリンクが貼られたときや、動画の内容が必要なときだけ使う（再生数・公開日・題名だけなら search_youtube や fetch_url で足りる）。一度要約した動画は保存済みの要約を返す。',
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
    description: 'このサーバーで依頼者が閲覧できるチャンネルの一覧（ID・名前・種類・カテゴリ・説明）を得る。どのチャンネルで何を話すか聞かれたとき、当てはまるチャンネルを探すとき、ボイス/ステージでイベントを行う場合のチャンネル選びに使う。'
  },
  {
    name: 'get_server_rules',
    description: 'このサーバーのルール・必読・はじめに等のチャンネルに書かれている内容を読む。サーバーのルール・禁止事項・決まりについて聞かれたとき、またはイベントやフォーラム投稿を作る前にルールを確認するときに使う。'
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
    description: 'このサーバーに登録済みのスケジュールイベントの一覧を得る。サーバーの予定やイベントを聞かれたとき、イベント登録で重複を避けるときに使う。'
  },
  {
    name: 'search_youtube',
    description: 'このサーバーに設定された YouTube チャンネルについて保存している情報（チャンネル登録者数・概要、動画の題名・公開日・配信日時・長さ・再生数・高評価数・コメント数・保存済みの要約、配信予定・配信中）や、指定された YouTube 動画 URL の正確な情報を探す。動画の再生数や投稿日・配信日、一番再生されている動画・一番古い動画・最新の動画、おすすめの動画・名作・神回などを聞かれたときに必ず使う。',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: '探したい動画の題名・説明・要約・内容を表す語、または YouTube 動画の URL（空白区切り。意味が近い動画も探す。全動画から再生数順・新しい順・古い順で見たいときは省略可）' },
        sort: { type: 'STRING', enum: ['relevance', 'newest', 'oldest', 'views'], description: '並び順。再生数が多い順・人気順は views、古い順・最初の動画は oldest、新しい順・最新の動画は newest、関連度順は relevance（省略時は自動判定）' }
      }
    }
  },
  {
    name: 'search_twitch',
    description: 'BOT が見ている Twitch チャンネルの過去の配信（アーカイブ）を探す。題名・配信日（日本時間）・長さ・再生数・リンクが分かる（中で話した内容は分からない）。Twitch の配信やアーカイブについての依頼で使う。',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: '題名・説明に含まれる語（空白区切りで AND）' },
        sort: { type: 'STRING', enum: ['newest', 'oldest', 'views'], description: '並び順。再生数が多い順は views、古い順は oldest、新しい順は newest（省略時は自動判定）' }
      }
    }
  },
  {
    name: 'search_steam',
    description: 'BOT が見ている配信者の Steam アカウントについて保存している情報（プロフィール、所持・プレイ済みゲーム一覧とプレイ時間、最近遊んだゲーム、書いたレビュー、ウィッシュリスト）を探す。おすすめのゲームや好きなゲームを聞かれたとき、特定のゲームを遊んだことがあるか・どう思うか聞かれたとき、ゲームの話題に返すとき、Steam や所持ゲーム・プレイ時間・レビュー・ウィッシュリストについての依頼で使う。query を省くとおすすめレビュー・直近プレイ・プレイ時間順のゲームを返す。',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: '特定のゲーム名・英語名・ジャンル・レビュー本文に含まれる語（空白区切りで AND）。おすすめ全般やよく遊ぶゲームを知りたいときは省略する' },
        section: { type: 'STRING', enum: ['all', 'games', 'reviews', 'wishlist'], description: '調べる対象（省略するとおすすめレビューと所持ゲームを中心に返す。ウィッシュリストを見たいときは wishlist）' }
      }
    }
  }
]

// How much stored history one search reads, and how many matching messages it returns.
const HISTORY_SCAN = 1000
const MAX_HISTORY_RESULTS = 40
const MAX_HISTORY_TEXT = 500
const MAX_TOPIC = 100
const MAX_PROFILE_EMOJIS = 8
const MAX_YOUTUBE_RESULTS = 15
const LIVE_LABELS = { live: '配信中', upcoming: '配信予定' }

const CHANNEL_TYPES = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum', 16: 'media', 10: 'thread', 11: 'thread', 12: 'thread' }

function safePermissionsOf (channel, memberOrId) {
  if (!channel || typeof channel.permissionsOf !== 'function' || !memberOrId) return null
  const id = typeof memberOrId === 'string' ? memberOrId : (memberOrId.id || memberOrId.user?.id)
  try {
    return channel.permissionsOf(id)
  } catch (_) {
    if (typeof memberOrId === 'object') {
      try { return channel.permissionsOf(memberOrId) } catch (__) {}
    }
    return null
  }
}

function canView (channel, memberOrId) {
  const perms = safePermissionsOf(channel, memberOrId)
  if (!perms || !perms.has('viewChannel')) return false
  const id = typeof memberOrId === 'string' ? memberOrId : (memberOrId?.id || memberOrId?.user?.id)
  if (channel?.type === 12 && id !== global.bot?.user?.id && !perms.has('manageThreads')) {
    return Boolean(channel.members?.has?.(id))
  }
  return true
}

function canRead (channel, memberOrId) {
  const perms = safePermissionsOf(channel, memberOrId)
  if (!perms || !perms.has('viewChannel') || !perms.has('readMessageHistory')) return false
  const id = typeof memberOrId === 'string' ? memberOrId : (memberOrId?.id || memberOrId?.user?.id)
  if (channel?.type === 12 && id !== global.bot?.user?.id && !perms.has('manageThreads')) {
    return Boolean(channel.members?.has?.(id))
  }
  return true
}

// How many messages a reply chain is followed back, for a conversation with the bot.
const MAX_THREAD = 10

// Who wrote a message. In a conversation (a reply chain, given `requesterID`) the bot's own earlier
// replies read "あなた（BOT）" and the requester is marked, so the model can follow who said what.
function authorLabel (author, requesterID) {
  if (requesterID && author.id === global.bot.user.id) return 'あなた（BOT）'
  return `${author.username} (${author.id})${requesterID && author.id === requesterID ? '（依頼者）' : ''}`
}

const DEBUG_FOOTER_LINE = /(?:\r?\n|^)-#\s*(?:model:\s*[^\r\n]+?\s*·\s*)?tokens:\s*in\s+[^\r\n]+/g

function stripDebugFooter (text) {
  if (typeof text !== 'string') return ''
  return text.replace(DEBUG_FOOTER_LINE, '').trimEnd()
}

function formatMessage (m, requesterID = null) {
  const cleanContent = stripDebugFooter(m.content || '')
  const lines = [`[${new Date(m.timestamp).toISOString()}] ${authorLabel(m.author, requesterID)}: ${cleanContent}`]
  for (const e of m.embeds || []) {
    const text = [e.title, e.description, ...(e.fields || []).map(f => `${f.name}: ${f.value}`), e.url].filter(Boolean).join('\n')
    if (text) lines.push(`  埋め込み: ${text}`)
    for (const image of [e.image, e.thumbnail].filter(i => i?.url)) lines.push(`  埋め込み画像: ${image.url}`)
  }
  for (const a of m.attachments || []) lines.push(`  添付: ${a.filename} ${a.url}`)
  return lines.join('\n')
}

function messageImages (m) {
  const urls = []
  for (const a of m?.attachments || []) {
    if (a?.url && (/^image\//.test(a.content_type || '') || /\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(a.filename || a.url || ''))) {
      urls.push(a.url)
    }
  }
  for (const e of m?.embeds || []) {
    for (const image of [e?.image, e?.thumbnail]) {
      if (image?.url && !urls.includes(image.url)) urls.push(image.url)
    }
  }
  return urls
}

// Thrown to end the whole draft (the requester cancelled or stopped answering). Unlike a tool error
// it is not handed back to the model.
class StopDrafting extends Error {}

// progress(text): shows the requester what a slow tool is doing. Optional.
function createTools ({ guild, member, ask, progress = () => {} }) {
  const sources = []
  let questions = 0

  async function readableChannel (channelID) {
    const channel = global.bot.getChannel(channelID)
    if (!channel || channel.guild?.id !== guild.id) throw new Error('このサーバーのチャンネルではありません')
    const userPerms = safePermissionsOf(channel, member)
    if (!userPerms || !userPerms.has('viewChannel') || !userPerms.has('readMessageHistory')) {
      throw new Error('依頼者がこのチャンネルのメッセージを閲覧できません')
    }
    if (channel.type === 12 && !userPerms.has('manageThreads') && !channel.members?.has?.(member.id)) {
      const joined = await global.bot.requestHandler?.request?.('GET', `/channels/${channel.id}/thread-members/${member.id}`, true)
        .then(res => Boolean(res?.user_id || res?.id), () => false)
      if (!joined) throw new Error('依頼者がこのプライベートスレッドを閲覧できません')
    }
    if (!canRead(channel, global.bot.user.id)) throw new Error('BOTがこのチャンネルのメッセージを閲覧できません')
    return channel
  }

  async function readMessage (channelID, messageID) {
    await readableChannel(channelID)
    return formatMessage(await global.bot.getMessage(channelID, messageID))
  }

  // The replied-to message and the replies it continues, oldest first: the conversation the
  // mention is part of. Stops at the start of the chain, a deleted message, or MAX_THREAD.
  async function readThread (channelID, messageID) {
    const messages = []
    let next = { channelID, messageID }
    while (next?.messageID && messages.length < MAX_THREAD) {
      await readableChannel(next.channelID)
      const m = await global.bot.getMessage(next.channelID, next.messageID).catch(e => {
        if (messages.length === 0) throw e
        return null
      })
      if (!m) break
      messages.unshift(m.id ? m : { ...m, id: next.messageID })
      next = m.messageReference && { channelID: m.messageReference.channelID || next.channelID, messageID: m.messageReference.messageID }
    }
    let lastBotModel = null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.author?.id === global.bot.user.id && typeof m.content === 'string') {
        const footerMatch = m.content.match(/(?:^|\r?\n)-#\s*model:\s*(.+?)\s*·\s*tokens:/)
        if (footerMatch) {
          const candidate = footerMatch[1].split('→').pop().replace(/\s*\(flex\)\s*$/i, '').trim()
          if (candidate && !/^gemini-/i.test(candidate)) {
            lastBotModel = candidate
            break
          }
        }
      }
    }
    const images = [...new Set(messages.flatMap(m => messageImages(m)))].slice(-4)
    return {
      text: messages.map(m => formatMessage(m, member.id)).join('\n'),
      count: messages.length,
      // The conversation without the bot's own replies: what knowledge is looked up by
      // (describeServer), so the bot's earlier answers do not keep bringing back the same
      // knowledge, and with it the same jokes.
      othersText: messages.filter(m => m.author?.id !== global.bot.user.id).map(m => formatMessage(m, member.id)).join('\n'),
      messageIds: messages.map(m => m.id).filter(Boolean),
      images,
      ...(lastBotModel ? { lastBotModel } : {})
    }
  }

  const executors = {
    async fetch_url ({ url }) {
      if (MESSAGE_LINK.test(url) || CHANNEL_LINK.test(url)) return executors.get_discord_message({ link: url })
      const ytVideoID = parseVideoId(url)
      if (ytVideoID) {
        const video = await lookupYouTubeVideo(ytVideoID)
        if (video) {
          const link = `https://www.youtube.com/watch?v=${ytVideoID}`
          sources.push(link)
          return formatYouTubeVideoDetail(video)
        }
      }
      const page = await urlFetcher.fetchPageText(url)
      sources.push(page.url)
      return page.text
    },
    async get_discord_message ({ link }) {
      const channelLink = String(link).match(CHANNEL_LINK)
      if (channelLink) {
        if (channelLink[1] !== guild.id) throw new Error('別のサーバーのチャンネルは読めません')
        return executors.get_recent_messages({ channel_id: channelLink[2] })
      }
      const match = String(link).match(MESSAGE_LINK)
      if (!match) throw new Error('Discord のメッセージリンクではありません')
      if (match[1] !== guild.id) throw new Error('別のサーバーのメッセージは読めません')
      const text = await readMessage(match[2], match[3])
      sources.push(match[0])
      return text
    },
    async get_recent_messages ({ channel_id: channelID, limit }) {
      const channel = await readableChannel(channelID)
      const count = Math.min(Math.max(parseInt(limit, 10) || 20, 1), MAX_RECENT_MESSAGES)
      const messages = await global.bot.getMessages(channelID, { limit: count })
      sources.push(`<#${channel.id}>`)
      return messages.filter(Boolean).map(m => formatMessage(m)).join('\n') // null: one Eris could not read
    },
    async search_channel_history ({ channel_id: channelID, query }) {
      const channel = await readableChannel(channelID)
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
      const channels = [...guild.channels.values()].filter(c => canRead(c, member) && canRead(c, global.bot.user.id))
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
      const all = [...guild.channels.values()]
      const order = c => [guild.channels.get(c.parentID)?.position ?? -1, c.position ?? 0]
      return all
        .filter(c => c.type !== 4 && canView(c, member))
        .sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1])
        .map(c => {
          const category = guild.channels.get(c.parentID)?.name
          const topic = c.topic ? ` — ${c.topic.replace(/\s+/g, ' ').slice(0, MAX_TOPIC)}` : ''
          return `${c.id}: ${c.name}（${CHANNEL_TYPES[c.type] || c.type}）${category ? ` [${category}]` : ''}${topic}`
        })
        .join('\n')
    },
    async get_server_rules () {
      const rules = await serverRules.readRules(guild)
      if (!rules?.length) return 'このサーバーのルールチャンネルは見つかりませんでした'
      for (const r of rules) sources.push(`<#${r.channelID}>`)
      return rules.map(r => `### <#${r.channelID}> より\n${r.text}`).join('\n\n')
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
    async search_youtube ({ query, sort }) {
      return searchYouTube(guild.id, query, sort)
    },
    async search_twitch ({ query, sort }) {
      return searchTwitch(query, sort)
    },
    async search_steam ({ query, section }) {
      return searchSteam(query, section)
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
    async about_member ({ member: who }) {
      const found = findMembers(guild, who)
      if (found.length === 0) throw new Error(`「${who}」に当てはまるメンバーが見つかりません`)
      if (found.length > 1) return `「${who}」に当てはまるメンバーが複数います。どの人か依頼者に確かめてください:\n${found.slice(0, MAX_MEMBER_MATCHES).map(m => `- ${displayName(m)}（@${m.username}、ID: ${m.id}）`).join('\n')}`
      const [m] = found
      const roles = (m.roles || []).map(id => guild.roles.get(id)).filter(r => r && !r.managed).sort((a, b) => (b.position ?? 0) - (a.position ?? 0)).map(r => r.name)
      const channels = [...guild.channels.values()].filter(c => canRead(c, member) && canRead(c, global.bot.user.id))
      // The stored messages only where reading them for this is declared (SERVER_LORE, serverLore.js).
      const messages = serverLore.enabled() && channels.length ? await loreStore.memberMessages(guild.id, m.id, channels.map(c => c.id), MAX_MEMBER_MESSAGES) : []
      const channelName = id => guild.channels.get(id)?.name || id
      return [
        `表示名: ${displayName(m)}（@${m.username}、ID: ${m.id}）${m.bot ? '（BOT）' : ''}`,
        `ロール: ${roles.join(', ') || 'なし'}`,
        m.joinedAt ? `サーバーに参加: ${formatJstDate(m.joinedAt)}` : '',
        '',
        messages.length
          ? [`最近の発言（新しい順、依頼者が読めるチャンネルのもの ${messages.length} 件）:`, ...messages.map(r => `[${formatJstDate(r.ts)}] #${channelName(r.channel_id)}: ${fromStoredContent(r.content).replace(/\s+/g, ' ').slice(0, MAX_HISTORY_TEXT / 2)}`)].join('\n')
          : serverLore.enabled()
            ? '保存されている発言はありません（このサーバーではメッセージを保存していないか、読めるチャンネルでの発言がありません）'
            : '（発言は参照しない設定です。分かるのは上の情報だけです）',
        '（その場で読んだもので、保存されません）'
      ].filter(l => l !== '').join('\n')
    },
    async summarize_youtube_video ({ url }) {
      const { videoID, summary, cached } = await videoSummary.summarizeVideo(guild.id, url, {
        onStart: timeoutMs => progress(`動画の内容を読み取っています…（長い動画は数分かかります。最大 ${Math.round(timeoutMs / 60000)} 分）`)
      })
      const link = `https://www.youtube.com/watch?v=${videoID}`
      sources.push(link)
      const meta = await lookupYouTubeVideo(videoID)
      const metaLine = meta ? `動画情報: ${formatVideo({ ...meta, description: '', summary: null }).replace(/^- /, '')}\n` : ''
      return `${metaLine}${link} の内容の要約${cached ? '（保存済み）' : ''}:\n${linkTimestamps(summary, videoID)}`
    }
  }

  // Errors go back to the model as the tool result, so it can tell the user what it couldn't read
  // instead of the whole draft failing.
  async function call (name, args) {
    if (!executors[name]) return { error: `不明なツールです: ${name}` }
    try {
      const result = String(await executors[name](args || {})).slice(0, MAX_RESULT_CHARS)
      await reportInjectionAsync(`the ${name} result in ${guild.id}`, result)
      // Whatever a tool read was written by someone else: marked off as data (untrusted.js).
      return { result: wrap(name, result) }
    } catch (e) {
      if (e instanceof StopDrafting) throw e
      return { error: e.message }
    }
  }

  const declarations = [...DECLARATIONS, FIND_GAME, ABOUT_MEMBER, ...(messageEmbeddingsEnabled() ? [SEARCH_SERVER_MESSAGES] : []), ...(wikiKnowledge.searchable() ? [SEARCH_WIKI] : [])]
  return { declarations, call, sources, readMessage, readThread, progress }
}

async function scheduledEvents (guild) {
  const events = await global.bot.requestHandler.request('GET', `/guilds/${guild.id}/scheduled-events`, true)
  if (events.length === 0) return '登録済みのイベントはありません'
  return events.map(e => `${e.name}: ${e.scheduled_start_time}〜${e.scheduled_end_time || ''} ${e.entity_metadata?.location || (e.channel_id ? `<#${e.channel_id}>` : '')}`).join('\n')
}

const LIVE_STATS_TTL_MS = 10 * 60 * 1000

function apiVideoToStored (v, existing = {}) {
  return {
    ...existing,
    video_id: v.id,
    channel_id: v.channelId || existing.channel_id || null,
    channel_title: v.channelTitle || existing.channel_title || null,
    title: v.title,
    description: v.description,
    published_at: v.publishedAt || existing.published_at || null,
    live_status: v.liveStatus || existing.live_status || 'none',
    scheduled_start: v.scheduledStart ?? existing.scheduled_start ?? null,
    actual_start: v.actualStart ?? existing.actual_start ?? null,
    actual_end: v.actualEnd ?? existing.actual_end ?? null,
    duration: v.duration ?? existing.duration ?? null,
    view_count: v.viewCount ?? existing.view_count ?? null,
    like_count: v.likeCount ?? existing.like_count ?? null,
    comment_count: v.commentCount ?? existing.comment_count ?? null,
    stats_updated_at: new Date(),
    url: v.url || `https://www.youtube.com/watch?v=${v.id}`
  }
}

async function lookupYouTubeVideo (videoID) {
  const stored = typeof youtubeDB.getVideo === 'function' ? await youtubeDB.getVideo(videoID).catch(() => null) : null
  const summary = stored?.summary || await youtubeDB.getSummary(videoID).catch(() => null)
  if (process.env.YOUTUBE_API_KEY) {
    const liveList = await fetchVideos([videoID], process.env.YOUTUBE_API_KEY).catch(() => null)
    if (liveList?.[0]) {
      const live = liveList[0]
      if (stored?.channel_id) await youtubeDB.upsertVideos(stored.channel_id, [live]).catch(() => {})
      return apiVideoToStored(live, { ...(stored || {}), summary })
    }
  }
  return stored ? { ...stored, summary } : null
}

function formatYouTubeVideoDetail (v) {
  const link = v.url || `https://www.youtube.com/watch?v=${v.video_id}`
  const live = LIVE_LABELS[v.live_status]
  const streamStart = v.actual_start || v.scheduled_start
  const dur = formatDuration(v.duration)
  const views = formatCount(v.view_count, '回')
  const likes = formatCount(v.like_count)
  const comments = formatCount(v.comment_count, '件')
  const lines = [
    '動画情報（YouTube Data API / 保存データ）:',
    `題名: ${v.title}`,
    `URL: ${link}`,
    v.channel_title ? `チャンネル: ${v.channel_title}${v.channel_id ? ` (https://www.youtube.com/channel/${v.channel_id})` : ''}` : '',
    `公開日時（日本時間）: ${formatJstIso(v.published_at) || '?'}（公開日: ${formatJstDate(v.published_at) || '?'}）`,
    streamStart ? `配信日時（日本時間）: ${formatJstIso(streamStart)}${v.actual_end ? `〜${formatJstIso(v.actual_end)}` : ''}${live ? `（${live}）` : ''}` : '',
    dur ? `長さ: ${dur}` : '',
    views ? `再生回数: ${views}` : '',
    likes ? `高評価数: ${likes}` : '',
    comments ? `コメント数: ${comments}` : '',
    v.description ? `概要欄:\n${v.description}` : '',
    v.summary ? `保存済みの内容要約:\n${linkTimestamps(v.summary, v.video_id)}` : ''
  ]
  return lines.filter(Boolean).join('\n')
}

async function refreshShownVideos (list) {
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey || !list.length) return list
  const now = Date.now()
  const stale = list.filter(v => {
    if (!v.video_id || !/^[\w-]{11}$/.test(v.video_id)) return false
    if (v.view_count === null || v.view_count === undefined || !v.stats_updated_at) return true
    return now - new Date(v.stats_updated_at).getTime() > LIVE_STATS_TTL_MS
  })
  if (!stale.length) return list
  const liveList = await fetchVideos(stale.map(v => v.video_id), apiKey).catch(() => null)
  if (!liveList?.length) return list
  const byChannel = new Map()
  const liveById = new Map()
  for (const live of liveList) {
    liveById.set(live.id, live)
    const existing = stale.find(v => v.video_id === live.id)
    const chId = existing?.channel_id || live.channelId
    if (chId) {
      if (!byChannel.has(chId)) byChannel.set(chId, [])
      byChannel.get(chId).push(live)
    }
  }
  for (const [chId, vids] of byChannel) {
    await youtubeDB.upsertVideos(chId, vids).catch(() => {})
  }
  return list.map(v => liveById.has(v.video_id) ? apiVideoToStored(liveById.get(v.video_id), v) : v)
}

function formatVideo (v) {
  const live = LIVE_LABELS[v.live_status]
  const liveStart = v.actual_start || v.scheduled_start
  const when = live && liveStart ? `${live} ${formatJstIso(liveStart)}` : live
  const published = formatJstDate(v.published_at) || '?'
  const streamAt = !live && liveStart ? formatJstIso(liveStart) : null
  const details = []
  if (streamAt) details.push(`配信 ${streamAt}`)
  details.push(`公開 ${published}`)
  const dur = formatDuration(v.duration)
  if (dur) details.push(`長さ ${dur}`)
  const views = formatCount(v.view_count, '回')
  if (views) details.push(`再生 ${views}`)
  const likes = formatCount(v.like_count)
  if (likes) details.push(`高評価 ${likes}`)
  const comments = formatCount(v.comment_count, '件')
  if (comments) details.push(`コメント ${comments}`)
  const head = `- ${when ? `[${when}] ` : ''}${v.title}（${details.join('、')}）${v.url}`
  const description = (v.description || '').replace(/\s+/g, ' ').slice(0, 200)
  const lines = [head]
  if (description) lines.push(`  ${description}`)
  if (v.summary) lines.push(`  内容の要約: ${linkTimestamps(v.summary.replace(/\s+/g, ' ').slice(0, 400), v.video_id)}`)
  return lines.join('\n')
}

const matchesAll = (words, text) => words.every(w => text.toLowerCase().includes(w))
const VIDEO_PARTICLES = '(?:の|が|は|を|に|で|と|も|や|か|な|だ|です|ます|した|して|いる|てる|ある|順|系|件|本)'
const YOUTUBE_META_ATOM = '(?:おすすめ|オススメ|推奨|動画|配信|放送|実況|投稿|神回|名作|隠れた|面白い|おもしろい|好き|好きな|人気|ランキング|再生回数|再生数|視聴回数|再生|伸びてる|伸びた|見られてる|見られた|一番|最も|いちばん|トップ|上位|最近|直近|最新|過去|最初|最古|初投稿|古い|新しい|多い|高い|少ない|アーカイブ|youtube|ユーチューブ|つべ|のばまん|nobaman)'
const TWITCH_META_ATOM = '(?:おすすめ|オススメ|推奨|動画|配信|放送|実況|投稿|アーカイブ|人気|ランキング|再生回数|再生数|視聴回数|再生|伸びてる|伸びた|見られてる|見られた|一番|最も|いちばん|トップ|上位|最近|直近|最新|過去|最初|最古|古い|新しい|多い|高い|少ない|twitch|ツイッチ|のばまん|nobaman)'
const YOUTUBE_META_TOKEN = new RegExp(`^(?:${YOUTUBE_META_ATOM}|${VIDEO_PARTICLES})+$`, 'i')
const TWITCH_META_TOKEN = new RegExp(`^(?:${TWITCH_META_ATOM}|${VIDEO_PARTICLES})+$`, 'i')
const TRAILING_SORT_META = /(?:の|で)?(?:一番|最も|いちばん)?(?:再生(?:回数|数)|視聴回数|人気|古い|新しい)(?:が|の)?(?:多い|高い|少ない|順|ランキング|動画|配信|放送|アーカイブ)+$/i
const VALID_VIDEO_SORTS = new Set(['relevance', 'newest', 'oldest', 'views'])

function filterVideoQueryWords (rawWords, metaToken) {
  return rawWords
    .map(w => metaToken.test(w) ? '' : w.replace(TRAILING_SORT_META, ''))
    .filter(Boolean)
}

function inferVideoSort (query, explicitSort, allowed = VALID_VIDEO_SORTS) {
  if (explicitSort && allowed.has(explicitSort)) return explicitSort
  const q = String(query || '')
  if (/再生(?:数|回数)?(?:が|の)?(?:多い|高い|トップ|上位|順|ランキング)|一番(?:伸びて|再生|見られて)|最も(?:再生|見られて)|人気順|伸びてる/.test(q)) {
    return 'views'
  }
  if (/一番古い|最も古い|最古|最初(?:の|に投稿|に出した)|初投稿|古い順/.test(q)) {
    return 'oldest'
  }
  if (/一番新しい|最新|新しい順/.test(q)) {
    return 'newest'
  }
  return allowed.has('relevance') ? 'relevance' : 'newest'
}

async function searchYouTube (guildID, query, sort) {
  const linkedIds = parseVideoIds(query)
  const cleanedQuery = linkedIds.length ? String(query || '').replace(/https?:\/\/\S+/gi, ' ') : String(query || '')
  const rawWords = cleanedQuery.toLowerCase().split(/\s+/).filter(Boolean)
  const words = filterVideoQueryWords(rawWords, YOUTUBE_META_TOKEN)
  const sortMode = inferVideoSort(query, sort)
  const knowledge = await youtubeDB.getKnowledge(guildID)
  const storedIdSet = new Set((knowledge?.videos || []).map(v => v.video_id))
  const externalIds = linkedIds.filter(id => !storedIdSet.has(id))
  const externalVideos = externalIds.length && process.env.YOUTUBE_API_KEY
    ? await fetchVideos(externalIds, process.env.YOUTUBE_API_KEY).then(list => Promise.all(list.map(async v => {
      const summary = await youtubeDB.getSummary(v.id).catch(() => null)
      return apiVideoToStored(v, { summary })
    }))).catch(() => [])
    : []
  const externalLines = externalVideos.length
    ? [
        '指定された YouTube 動画:',
        ...externalVideos.map(v => v.channel_title ? formatVideo(v).replace(/^- /, `- 【${v.channel_title}】`) : formatVideo(v))
      ]
    : []

  // Summaries of linked videos from other channels are knowledge too.
  const externalFetchedSet = new Set(externalVideos.map(v => v.video_id))
  const others = (await youtubeDB.getOtherSummaries())
    .filter(s => !externalFetchedSet.has(s.video_id) && (linkedIds.includes(s.video_id) || matchesAll(words.length ? words : rawWords, s.summary)))
    .map(s => `- https://www.youtube.com/watch?v=${s.video_id}\n  内容の要約: ${linkTimestamps(s.summary.replace(/\s+/g, ' ').slice(0, 400), s.video_id)}`)
  const otherLines = others.length ? ['', `その他の要約済み動画（${others.length} 件）:`, ...others.slice(0, MAX_YOUTUBE_RESULTS)] : []

  if (!knowledge) return [...externalLines, 'BOT が見ている YouTube チャンネルはありません', ...otherLines].filter(Boolean).join('\n')
  const { videos } = knowledge
  const channels = (knowledge.channels || [knowledge.channel]).filter(c => c.synced_at)
  if (!channels.length) return [...externalLines, 'YouTube チャンネルはまだ情報を取得していません（しばらくすると自動で取得されます）', ...otherLines].filter(Boolean).join('\n')
  const channelName = new Map(channels.map(c => [c.channel_id, c.title]))
  const videoText = v => `${v.video_id || ''}\n${v.title}\n${v.description || ''}\n${v.summary || ''}`
  const linkedOnly = linkedIds.length > 0 && words.length === 0
  const matches = linkedOnly
    ? videos.filter(v => linkedIds.includes(v.video_id))
    : videos.filter(v => (linkedIds.length && linkedIds.includes(v.video_id)) || matchesAll(words, videoText(v)))
  const rawMatches = rawWords.length ? videos.filter(v => matchesAll(rawWords, videoText(v))) : matches
  // By meaning when embeddings exist and relevance order was asked, so different wording still finds the video.
  const ranked = !linkedOnly && sortMode === 'relevance' && rawWords.length
    ? await semanticSearch.rankVideos(guildID, videos, cleanedQuery).catch(e => {
      global.logger.warn(`Semantic YouTube search failed, using keywords: ${e.message}`)
      return null
    })
    : null

  let ordered
  if (linkedOnly) {
    ordered = matches
  } else if (sortMode === 'views') {
    const poolVideos = words.length ? matches : videos
    ordered = [...poolVideos].sort((a, b) => (b.view_count ?? -1) - (a.view_count ?? -1) || new Date(b.published_at || 0) - new Date(a.published_at || 0))
  } else if (sortMode === 'oldest') {
    const poolVideos = words.length ? matches : videos
    ordered = [...poolVideos].sort((a, b) => new Date(a.published_at || 0) - new Date(b.published_at || 0))
  } else if (sortMode === 'newest') {
    const poolVideos = words.length ? matches : videos
    ordered = [...poolVideos].sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0))
  } else {
    // Otherwise lives first: "the next stream" is the usual question.
    ordered = ranked || [...matches.filter(v => LIVE_LABELS[v.live_status]), ...matches.filter(v => !LIVE_LABELS[v.live_status])]
  }

  let shown = await refreshShownVideos(ordered.slice(0, MAX_YOUTUBE_RESULTS))
  if (sortMode === 'views') {
    shown = [...shown].sort((a, b) => (b.view_count ?? -1) - (a.view_count ?? -1) || new Date(b.published_at || 0) - new Date(a.published_at || 0))
  }
  const renderVideo = v => channels.length > 1 && channelName.get(v.channel_id) ? formatVideo(v).replace(/^- /, `- 【${channelName.get(v.channel_id)}】`) : formatVideo(v)
  const fallbackCandidates = (!ranked && !linkedOnly && words.length && !matches.length && !others.length && !externalVideos.length && videos.length)
    ? (sortMode === 'views'
        ? [...videos].sort((a, b) => (b.view_count ?? -1) - (a.view_count ?? -1) || new Date(b.published_at || 0) - new Date(a.published_at || 0))
        : sortMode === 'oldest'
          ? [...videos].sort((a, b) => new Date(a.published_at || 0) - new Date(b.published_at || 0))
          : [...videos.filter(v => v.summary), ...videos.filter(v => !v.summary)]
      ).slice(0, MAX_YOUTUBE_RESULTS)
    : []
  const fallbackVideos = fallbackCandidates.length ? await refreshShownVideos(fallbackCandidates) : []

  const missingStatsCount = sortMode === 'views'
    ? (words.length ? matches : videos).filter(v => v.view_count === null || v.view_count === undefined).length
    : 0
  let heading = ''
  if (linkedOnly) {
    heading = matches.length ? `指定されたチャンネル内動画: ${matches.length} 件` : ''
  } else if (sortMode === 'views') {
    const missingNote = missingStatsCount > shown.length ? `、うち再生数未取得 ${missingStatsCount - shown.filter(v => v.view_count != null).length} 件` : ''
    heading = words.length
      ? `「${query}」に一致した動画（再生数の多い順、${matches.length} 件${missingNote}）:`
      : `再生数の多い順の動画（${videos.length} 件${missingNote}）:`
  } else if (sortMode === 'oldest') {
    heading = words.length ? `「${query}」に一致した動画（古い順、${matches.length} 件）:` : '古い順の動画:'
  } else if (ranked) {
    heading = `「${query}」に意味が近い順の動画（語をすべて含むもの ${rawMatches.length} 件を優先）:`
  } else if (words.length) {
    heading = `「${query}」に一致した動画: ${matches.length} 件`
  } else {
    heading = '新しい順の動画:'
  }

  const formatChannelHeader = c => {
    const subs = formatCount(c.subscriber_count, '人')
    const totalViews = formatCount(c.view_count, '回')
    const meta = [
      c.url,
      subs ? `登録者 ${subs}` : '',
      totalViews ? `総再生 ${totalViews}` : '',
      `取得 ${new Date(c.synced_at).toISOString()}`
    ].filter(Boolean).join('、')
    return `チャンネル: ${c.title}（${meta}）${c.description ? `\n  概要: ${c.description.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`
  }

  return [
    ...externalLines,
    ...channels.map(formatChannelHeader),
    `保存している動画 ${videos.length} 件、うち内容の要約あり ${videos.filter(v => v.summary).length} 件`,
    heading,
    ...shown.map(renderVideo),
    ...(!ranked && !linkedOnly && ordered.length > MAX_YOUTUBE_RESULTS ? [`…ほか ${ordered.length - MAX_YOUTUBE_RESULTS} 件（query で絞り込めます）`] : []),
    ...(fallbackVideos.length
      ? ['', '（指定の語が直接含まれる動画はありませんでした。以下は保存済みの動画です。内容が合うものがあればここから選んでください）', ...fallbackVideos.map(renderVideo)]
      : []),
    ...otherLines
  ].filter(Boolean).join('\n')
}

const TWITCH_SORTS = new Set(['newest', 'oldest', 'views'])

// The Twitch archives (twitchSync.js) that have every word of `query` in their title or
// description, ordered by `sort` (newest first by default).
async function searchTwitch (query, sort) {
  const rawWords = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  const words = filterVideoQueryWords(rawWords, TWITCH_META_TOKEN)
  const sortMode = inferVideoSort(query, sort, TWITCH_SORTS)
  const [channels, archives] = await Promise.all([twitchDB.getOverview(), twitchDB.getArchives()])
  if (!channels.length) return 'BOT が見ている Twitch チャンネルはありません'
  const filtered = archives.filter(v => matchesAll(words, `${v.title}\n${v.description || ''}`))
  const matches = sortMode === 'views'
    ? [...filtered].sort((a, b) => (Number(b.view_count) || 0) - (Number(a.view_count) || 0) || new Date(b.published_at || 0) - new Date(a.published_at || 0))
    : sortMode === 'oldest'
      ? [...filtered].sort((a, b) => new Date(a.published_at || 0) - new Date(b.published_at || 0))
      : filtered
  const line = v => {
    const date = formatJstDate(v.published_at) || '?'
    const who = channels.length > 1 ? `【${v.display_name || v.login}】` : ''
    const views = formatCount(v.view_count, '回')
    return `- ${who}${v.title}（配信 ${date}${v.duration ? `、長さ ${v.duration}` : ''}${views ? `、再生 ${views}` : ''}）${v.url}`
  }
  const heading = sortMode === 'views'
    ? (words.length ? `「${query}」に一致したアーカイブ（再生数の多い順、${matches.length} 件）:` : '再生数の多い順のアーカイブ:')
    : sortMode === 'oldest'
      ? (words.length ? `「${query}」に一致したアーカイブ（古い順、${matches.length} 件）:` : '古い順のアーカイブ:')
      : (words.length ? `「${query}」に一致したアーカイブ: ${matches.length} 件` : '新しい順のアーカイブ:')
  return [
    ...channels.map(c => `チャンネル: ${c.display_name || c.login}（https://www.twitch.tv/${c.login}、アーカイブ ${c.video_count} 件${c.synced_at ? `、取得 ${new Date(c.synced_at).toISOString()}` : '、まだ取得していない'}）${c.description ? `\n  概要: ${c.description.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`),
    'Twitch はアーカイブを一定期間（7〜60日）で消すため、古い配信は残っていない。',
    heading,
    ...matches.slice(0, MAX_YOUTUBE_RESULTS).map(line),
    ...(matches.length > MAX_YOUTUBE_RESULTS ? [`…ほか ${matches.length - MAX_YOUTUBE_RESULTS} 件（query で絞り込めます）`] : [])
  ].join('\n')
}

const MAX_STEAM_GAMES = 25
const MAX_STEAM_REVIEWS = 15
const MAX_STEAM_WISHLIST = 25
const STEAM_META_WORDS = /^(?:おすすめ|オススメ|推奨|ゲーム|神ゲー|名作|面白い|おもしろい|好き|好きな|人気|ランキング|プレイ|時間|最近|直近|レビュー|感想|評価|ウィッシュリスト|steam|スチーム|のばまん|nobaman)$/i

// The streamer's Steam profile, owned/played games, reviews and wishlist (steamSync.js).
async function searchSteam (query, section = 'all') {
  const rawWords = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  const words = rawWords.filter(w => !STEAM_META_WORDS.test(w))
  const [profiles, games, reviews, wishlist] = await Promise.all([
    steamDB.getOverview(),
    steamDB.getGames(),
    steamDB.getReviews(),
    steamDB.getWishlist()
  ])
  if (!profiles.length) return 'BOT が見ている Steam アカウントはありません'

  const profileUrl = p => `https://steamcommunity.com/${p.custom_url ? `id/${p.custom_url}` : `profiles/${p.steam_id}`}`
  const whoPrefix = p => profiles.length > 1 ? `【${p.persona_name || p.account_ref}】` : ''

  const reviewByApp = new Map(reviews.map(r => [`${r.steam_id}:${r.app_id}`, r]))
  const matchedGames = games.filter(g => {
    const r = reviewByApp.get(`${g.steam_id}:${g.app_id}`)
    return matchesAll(words, `${g.name}\n${g.name_en || ''}\n${g.app_id}\n${r?.content || ''}`)
  })
  const matchedReviews = reviews.filter(r => {
    const recLabel = r.recommended ? 'おすすめ オススメ recommended' : 'おすすめしない おすすめしません not recommended'
    return matchesAll(words, `${r.name || ''}\n${r.name_en || ''}\n${r.content}\n${r.app_id}\n${recLabel}`)
  })
  const matchedWishlist = wishlist.filter(w => matchesAll(words, `${w.name}\n${w.name_en || ''}\n${w.app_id}`))

  const formatGame = g => {
    const en = g.name_en && g.name_en !== g.name ? ` / ${g.name_en}` : ''
    const hours = Number.isFinite(g.playtime_hours) ? `${g.playtime_hours}時間` : '時間不明'
    const recent = Number.isFinite(g.recent_hours) && g.recent_hours > 0 ? `、直近2週間 ${g.recent_hours}時間` : ''
    const first = g.first_played_at ? `、初プレイ ${formatJstDate(g.first_played_at)}` : ''
    const rev = reviewByApp.get(`${g.steam_id}:${g.app_id}`)
    const revBadge = rev ? `［レビュー: ${rev.recommended ? 'おすすめ' : 'おすすめしない'}］` : ''
    return `- ${whoPrefix(g)}${g.name}${en}（総プレイ ${hours}${recent}${first}）${revBadge}https://store.steampowered.com/app/${g.app_id}/`
  }

  const formatReview = r => {
    const label = r.recommended ? 'おすすめ' : 'おすすめしない'
    const hours = Number.isFinite(r.hours_on_record) ? `、${r.hours_on_record}時間` : ''
    const posted = r.posted ? `、投稿 ${r.posted}` : ''
    const text = (r.content || '').replace(/\s+/g, ' ').slice(0, 300)
    return `- ${whoPrefix(r)}【${r.name || `App ${r.app_id}`}】${label}${hours}${posted} ${r.url} （ストア: https://store.steampowered.com/app/${r.app_id}/）\n  ${text}`
  }

  const formatWish = w => {
    const en = w.name_en && w.name_en !== w.name ? ` / ${w.name_en}` : ''
    const added = w.added_at ? `（追加 ${formatJstDate(w.added_at)}）` : ''
    return `- ${whoPrefix(w)}${w.name}${en}${added} https://store.steampowered.com/app/${w.app_id}/`
  }

  const lines = [
    ...profiles.map(p => [
      `アカウント: ${p.persona_name || p.account_ref}（${profileUrl(p)}、SteamID: ${p.steam_id}${p.level ? `、Lv.${p.level}` : ''}${p.member_since ? `、登録 ${p.member_since}` : ''}）`,
      `  所持・プレイ確認ゲーム: ${p.stored_game_count} 本保存${p.game_count ? `（プロフィール上の所持総数 ${p.game_count} 本）` : ''}、レビュー: ${p.review_count} 件、ウィッシュリスト: ${p.stored_wishlist_count} 本保存${p.wishlist_count ? `（総数 ${p.wishlist_count} 本）` : ''}${p.synced_at ? `、取得 ${new Date(p.synced_at).toISOString()}` : ''}`,
      p.summary ? `  自己紹介: ${p.summary.replace(/\s+/g, ' ').slice(0, 200)}` : ''
    ].filter(Boolean).join('\n'))
  ]

  const recentGames = !words.length && section !== 'reviews' && section !== 'wishlist'
    ? games.filter(g => Number.isFinite(g.recent_hours) && g.recent_hours > 0)
    : []
  if (recentGames.length) {
    lines.push('', `直近2週間にプレイしたゲーム（${recentGames.length} 本）:`, ...recentGames.map(formatGame))
  }

  if (section === 'all' || section === 'games') {
    lines.push(
      '',
      words.length ? `「${query}」に一致した所持・プレイ済みゲーム: ${matchedGames.length} 本` : 'プレイ時間が多い順の所持・プレイ済みゲーム:',
      ...matchedGames.slice(0, MAX_STEAM_GAMES).map(formatGame),
      ...(matchedGames.length > MAX_STEAM_GAMES ? [`…ほか ${matchedGames.length - MAX_STEAM_GAMES} 本（query で絞り込めます）`] : [])
    )
  }

  if (section === 'all' || section === 'reviews') {
    const recCount = reviews.filter(r => r.recommended).length
    lines.push(
      '',
      words.length ? `「${query}」に一致した Steam レビュー: ${matchedReviews.length} 件` : `Steam レビュー（全 ${reviews.length} 件、うちおすすめ ${recCount} 件）:`,
      ...matchedReviews.slice(0, MAX_STEAM_REVIEWS).map(formatReview),
      ...(matchedReviews.length > MAX_STEAM_REVIEWS ? [`…ほか ${matchedReviews.length - MAX_STEAM_REVIEWS} 件（query や section: "reviews" で絞り込めます）`] : [])
    )
  }

  if (section === 'wishlist' || (section === 'all' && words.length && matchedWishlist.length)) {
    lines.push(
      '',
      words.length ? `「${query}」に一致したウィッシュリスト: ${matchedWishlist.length} 本` : `ウィッシュリスト（新しい順、保存 ${wishlist.length} 本）:`,
      ...matchedWishlist.slice(0, MAX_STEAM_WISHLIST).map(formatWish),
      ...(matchedWishlist.length > MAX_STEAM_WISHLIST ? [`…ほか ${matchedWishlist.length - MAX_STEAM_WISHLIST} 本（query で絞り込めます）`] : [])
    )
  }

  if (words.length && !matchedGames.length && !matchedReviews.length && !matchedWishlist.length) {
    const topGames = games.slice(0, 15)
    const recReviews = reviews.filter(r => r.recommended).slice(0, 10)
    lines.push(
      '',
      '（指定の語が直接含まれるものはありませんでした。以下はプレイ時間上位の所持・プレイ済みゲームとおすすめレビューです。ジャンルや内容が合うものがあればここから選んでください）'
    )
    if (topGames.length) lines.push('プレイ時間が多い順の主なゲーム:', ...topGames.map(formatGame))
    if (recReviews.length) lines.push('Steam で「おすすめ」しているレビュー:', ...recReviews.map(formatReview))
  }

  return lines.join('\n')
}

const displayName = m => m.nick || m.user?.globalName || m.globalName || m.username

// The members `who` names: a mention or ID, else those whose name, nickname or user name is it (or,
// when none is, contains it).
function findMembers (guild, who) {
  const text = String(who || '').trim()
  const id = text.match(/^<@!?(\d+)>$/)?.[1] || (/^\d{15,}$/.test(text) ? text : null)
  if (id) return guild.members.get(id) ? [guild.members.get(id)] : []
  const q = text.replace(/^@/, '').toLowerCase()
  if (!q) return []
  const names = m => [m.nick, m.user?.globalName, m.globalName, m.username].filter(Boolean).map(n => n.toLowerCase())
  const members = [...guild.members.values()]
  const exact = members.filter(m => names(m).includes(q))
  return exact.length ? exact : members.filter(m => names(m).some(n => n.includes(q)))
}

const { usableEmojis } = emojiDescriber

function emojiCode (e) {
  return `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`
}

function canUseExternalEmojis (channelOrID, guild) {
  const c = typeof channelOrID === 'object' && channelOrID
    ? channelOrID
    : (channelOrID ? (global.bot?.getChannel?.(channelOrID) || guild?.channels?.get?.(channelOrID)) : null)
  if (c?.guild?.id && guild?.id && c.guild.id !== guild.id) return false
  const target = typeof c?.permissionsOf === 'function'
    ? c
    : (c?.parentID ? (guild?.channels?.get?.(c.parentID) || global.bot?.getChannel?.(c.parentID)) : null)
  const botID = global.bot?.user?.id || (guild?.members?.has?.('BOT') ? 'BOT' : null)
  if (!target || typeof target.permissionsOf !== 'function' || !botID) return false
  const perms = safePermissionsOf(target, botID)
  if (!perms) return false
  if (typeof perms.has === 'function') return Boolean(perms.has('externalEmojis'))
  return Boolean(perms.json?.externalEmojis)
}

// Usable custom emojis from OWNER_GUILD_IDS that the bot can post in `channelOrID` of `guild`.
// Empty when `guild` has no other owner servers to draw from, or when external emojis are denied
// in the target channel.
async function sharedOwnerEmojis (guild, channelOrID) {
  if (!guild?.id) return []
  const ownerIDs = ownerGuildIDs().filter(id => id && id !== guild.id)
  if (!ownerIDs.length) return []
  if (!canUseExternalEmojis(channelOrID, guild)) return []

  const seen = new Set(usableEmojis(guild).map(e => e.id))
  const out = []
  const missingGuildIDs = []

  for (const ownerID of ownerIDs) {
    const cachedGuild = global.bot?.guilds?.get?.(ownerID)
    if (cachedGuild) {
      for (const e of usableEmojis(cachedGuild)) {
        if (!seen.has(e.id)) {
          seen.add(e.id)
          out.push({ id: e.id, name: e.name, animated: !!e.animated, guildID: ownerID })
        }
      }
    } else {
      missingGuildIDs.push(ownerID)
    }
  }

  if (missingGuildIDs.length && emojiDescriber.enabled()) {
    const stored = await emojiStore.listEmojis(missingGuildIDs).catch(() => [])
    for (const e of stored) {
      if (e?.id && e?.name && !seen.has(e.id)) {
        seen.add(e.id)
        out.push({ id: e.id, name: e.name, animated: !!e.animated, guildID: e.guild_id })
      }
    }
  }

  return out
}

// The model sometimes writes a server emoji as :name: rather than its code, puts codes in ` (code
// formatting, where Discord shows them as text), or gets the ID or the a: of an animated one
// wrong. Emojis the server has (and usable owner-server `extraEmojis`, with the current server's
// own emojis winning on :name: collisions) are written as their exact code, outside code
// formatting; others are left as written.
const EMOJI = '(?:<a?:\\w{2,32}:\\d+>|:\\w{2,32}:)'
const CODED_EMOJIS = new RegExp(`(\`{1,3})\\s*(${EMOJI}(?:\\s*${EMOJI})*)\\s*\\1`, 'g')
const CODE_OR_URL_PREFIX = '```[\\s\\S]*?```|``[^`\\n]+``|`[^`\\n]+`|https?:\\/\\/\\S+'
function withServerEmojis (text, guild, extraEmojis = []) {
  const own = usableEmojis(guild)
  const extra = (extraEmojis || []).filter(e => e && e.id && e.name && e.available !== false && !(e.roles || []).length)
  const byName = new Map()
  const byID = new Map()
  for (const e of [...own, ...extra]) {
    if (!byName.has(e.name)) byName.set(e.name, e)
    if (!byID.has(e.id)) byID.set(e.id, e)
  }
  const find = (name, id, bare) => bare ? byName.get(bare) : (byID.get(id) || byName.get(name))
  const ONE = /<(a?):(\w{2,32}):(\d+)>|(?<![:\w]):(\w{2,32}):(?![:\w])/g
  const SAFE_ONE = new RegExp(`(${CODE_OR_URL_PREFIX})|<(a?):(\\w{2,32}):(\\d+)>|(?<![:\\w]):(\\w{2,32}):(?![:\\w])`, 'g')
  return text
    // Only when every emoji inside is usable here: anything else in ` may be meant as code.
    .replace(CODED_EMOJIS, (whole, ticks, inside) => [...inside.matchAll(ONE)].every(m => find(m[2], m[3], m[4])) ? inside : whole)
    .replace(SAFE_ONE, (whole, protectedSpan, animated, name, id, bare) => {
      if (protectedSpan) return whole
      const emoji = find(name, id, bare)
      return emoji ? emojiCode(emoji) : whole
    })
}

// The model sometimes writes a channel as #name rather than <#ID>, which Discord shows as a link.
// Names of channels the requester can see are turned into links; anything else is left as written
// (a hashtag, a URL fragment, <#ID> already).
function withServerChannels (text, guild, member) {
  const channels = [...guild.channels.values()]
    .filter(c => c.type !== 4 && c.name && canView(c, member))
    .sort((a, b) => b.name.length - a.name.length)
  if (!channels.length) return text
  const byName = new Map(channels.map(c => [c.name, c]))
  const names = [...byName.keys()].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(${CODE_OR_URL_PREFIX})|(?<![\\p{L}\\p{N}_/<&=-])#(${names.join('|')})(?![\\p{L}\\p{N}_-])`, 'gu')
  return text.replace(pattern, (whole, protectedSpan, name) => protectedSpan ? whole : `<#${byName.get(name).id}>`)
}

const GENERIC_CHANNEL_NAME = /^(?:general|chat|main|lobby|lounge|random|free|talk|bot|bots|bot[-_]?commands?|commands?|cmd|test|testing|sandbox|雑談|メイン|なんでも|フリー|ロビー|ラウンジ|おしゃべり|会話|チャット|全体|総合|ボット|コマンド|テスト|お試し|砂場|質問|相談)(?:[-_\s・｜|]*\d+)?$/iu
const SHORT_TOPIC_PROMPT = /[?？]|おすすめ|オススメ|名作|神回|教え|語ろ|好き|感想|評価|魅力|コツ|再生|日付|いつ|最初|最新|人気|ランキング/i
const MAX_THEME_CACHE = 128
const CHANNEL_THEME_WEIGHT = 0.45
const themeVectorCache = new Map()

function cleanChannelLabel (name) {
  const s = String(name || '')
    .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\p{S}\p{P}\s]+/gu, '')
    .replace(/^\d+\s*[-_｜|・:：]\s*/u, '')
    .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\p{S}\p{P}\s]+/gu, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/gu, '')
    .trim()
  if (!s || GENERIC_CHANNEL_NAME.test(s)) return ''
  return s
}

// Extracts the topical theme of the channel (name, parent channel for threads, and non-generic
// description), or '' for generic channels such as #general or #雑談.
function channelTheme (channelID, guild, fallbackName = '') {
  const c = (channelID && (global.bot?.getChannel?.(channelID) || guild?.channels?.get?.(channelID))) || null
  if (c && c.guild?.id && guild?.id && c.guild.id !== guild.id) return ''
  const isThread = c && [10, 11, 12].includes(c.type)
  const parent = c?.parentID ? guild?.channels?.get?.(c.parentID) || global.bot?.getChannel?.(c.parentID) : null
  const ownName = cleanChannelLabel(c?.name || fallbackName)
  const parentName = isThread ? cleanChannelLabel(parent?.name) : ''
  const parts = [ownName, parentName && parentName !== ownName ? parentName : ''].filter(Boolean)
  if (!parts.length) return ''
  const topic = (c?.topic || (isThread ? parent?.topic : '') || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TOPIC)
  if (topic && !/^(?:なんでも|自由|雑談)/.test(topic)) parts.push(topic)
  return parts.join(' — ')
}

async function cachedThemeVector (theme) {
  const key = `${embeddingModel()}\n${theme}`
  const hit = themeVectorCache.get(key)
  if (hit) {
    themeVectorCache.delete(key)
    themeVectorCache.set(key, hit)
    return hit
  }
  const vec = await embedQuery(theme)
  if (themeVectorCache.size >= MAX_THEME_CACHE) themeVectorCache.delete(themeVectorCache.keys().next().value)
  themeVectorCache.set(key, vec)
  return vec
}

// What the channel a request was made in is: its name, kind, category (or, for a thread, the
// channel it is in) and description. Null when unknown.
function requestChannelInfo (channelID, guild) {
  const c = global.bot?.getChannel?.(channelID) || guild?.channels?.get?.(channelID)
  if (!c || (c.guild?.id && guild?.id && c.guild.id !== guild.id)) return null
  const parent = c.parentID ? guild?.channels?.get?.(c.parentID) || global.bot?.getChannel?.(c.parentID) : null
  const isThread = [10, 11, 12].includes(c.type)
  return [
    `#${c.name}（ID: ${c.id}、${CHANNEL_TYPES[c.type] || c.type}${c.nsfw || (isThread && parent?.nsfw) ? '、年齢制限あり' : ''}`,
    parent ? (isThread ? `、<#${parent.id}>（#${parent.name}）の中のスレッド` : `、カテゴリ「${parent.name}」`) : '',
    '）',
    c.topic ? `\n  チャンネルの説明: ${c.topic.replace(/\s+/g, ' ').slice(0, MAX_TOPIC * 3)}` : '',
    isThread && parent?.topic ? `\n  親チャンネルの説明: ${parent.topic.replace(/\s+/g, ' ').slice(0, MAX_TOPIC * 3)}` : ''
  ].join('')
}

// The channels a message names (<#ID> or a link to one), as lines for the model:
// "<#ID>: #name（type）— topic". Only channels of the server the requester can see.
function namedChannels (texts, guild, member) {
  const ids = new Set()
  for (const t of texts) {
    for (const m of String(t || '').matchAll(/<#(\d+)>|discord(?:app)?\.com\/channels\/(\d+)\/(\d+)/g)) {
      if (m[1]) ids.add(m[1])
      else if (m[2] === guild.id) ids.add(m[3])
    }
  }
  return [...ids].map(id => guild.channels.get(id))
    .filter(c => c && canView(c, member))
    .map(c => `- <#${c.id}>: #${c.name}（${CHANNEL_TYPES[c.type] || c.type}）${c.topic ? ` — ${c.topic.replace(/\s+/g, ' ').slice(0, MAX_TOPIC)}` : ''}`)
}

// Who asked, and the members a message names (<@ID>), as lines for the model, so it knows who is
// who: "依頼した人: 表示名（@user、ID: …）", "<@ID>: 表示名（@user）". Members no longer in the
// server are left out.
function namedMembers (texts, guild, requester) {
  const name = m => displayName(m) || m.user?.username || m.id
  const user = m => m.username || m.user?.username || m.id
  const label = m => `${name(m)}（@${user(m)}${m.bot || m.user?.bot ? '、BOT' : ''}）`
  const lines = requester ? [`- 依頼した人（このメッセージを書いた人）: ${name(requester)}（@${user(requester)}、ID: ${requester.id}）`] : []
  const ids = new Set()
  for (const t of texts) for (const m of String(t || '').matchAll(/<@!?(\d+)>/g)) ids.add(m[1])
  for (const id of ids) {
    const m = guild.members.get(id)
    if (m && id !== global.bot.user.id) lines.push(`- <@${id}>: ${label(m)}${requester && id === requester.id ? '（依頼した人本人）' : ''}`)
  }
  return lines
}

function mentionedEmojiIDs (texts) {
  const ids = new Set()
  for (const t of texts) {
    for (const m of String(t || '').matchAll(/<a?:\w{2,32}:(\d{15,25})>/g)) ids.add(m[1])
  }
  return ids
}

function selectProfileEmojis (own, shared, { rank = null, mentioned = new Set(), limit = MAX_PROFILE_EMOJIS } = {}) {
  const order = list => [...list].sort((a, b) => {
    const ma = mentioned.has(a.id) ? 0 : 1
    const mb = mentioned.has(b.id) ? 0 : 1
    if (ma !== mb) return ma - mb
    return (rank?.get(a.id) ?? Infinity) - (rank?.get(b.id) ?? Infinity)
  })
  const ownOrdered = order(own)
  const sharedOrdered = order(shared)
  if (!sharedOrdered.length) return ownOrdered.slice(0, limit)
  if (!ownOrdered.length) return sharedOrdered.slice(0, limit)
  const half = Math.ceil(limit / 2)
  const ownQuota = Math.min(ownOrdered.length, Math.max(half, limit - sharedOrdered.length))
  const sharedQuota = Math.min(sharedOrdered.length, limit - ownQuota)
  const picked = [...ownOrdered.slice(0, ownQuota), ...sharedOrdered.slice(0, sharedQuota)]
  if (!rank) return picked
  return picked.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
}

const MAX_EMOJI_NOTE_CHARS = 80
function formatEmojiNoteLine (e, notes) {
  return notes[e.id]
    ? `- ${emojiCode(e)} ${String(notes[e.id]).replace(/\s+/g, ' ').slice(0, MAX_EMOJI_NOTE_CHARS)}`
    : `- ${emojiCode(e)}`
}

// The server's emojis (plus usable owner-server `sharedEmojis` when external emojis are allowed)
// for the model. With descriptions (emojiDescriber.js), one per line with what it shows and when
// to use it, those closest in meaning to the request first (`vectorOf()` resolves to its embedding,
// or null); otherwise just the codes.
async function emojiSection (guild, vectorOf, { sharedEmojis = [], mentioned = new Set() } = {}) {
  const ownEmojis = usableEmojis(guild)
  if (!ownEmojis.length && !sharedEmojis.length) return []
  const head = '### サーバー絵文字（返事で使うときは、この書き方のまま書く）'
  const guildIDs = [...new Set([guild.id, ...sharedEmojis.map(e => e.guildID)].filter(Boolean))]
  const storeTarget = guildIDs.length === 1 ? guildIDs[0] : guildIDs
  const notes = emojiDescriber.enabled() ? await emojiStore.descriptions(storeTarget).catch(() => ({})) : {}
  if (!Object.keys(notes).length) return [head, selectProfileEmojis(ownEmojis, sharedEmojis, { mentioned }).map(emojiCode).join(' ')]
  const vector = await vectorOf()
  if (!vector) {
    const picked = selectProfileEmojis(ownEmojis, sharedEmojis, { mentioned })
    if ([...mentioned].some(id => notes[id])) return [head, ...picked.map(e => formatEmojiNoteLine(e, notes))]
    return [head, picked.map(emojiCode).join(' ')]
  }
  const rankLimit = ownEmojis.length && sharedEmojis.length ? MAX_PROFILE_EMOJIS * 3 : MAX_PROFILE_EMOJIS
  const first = await emojiStore.nearestEmojis(storeTarget, vector, embeddingModel(), rankLimit)
    .catch(e => {
      global.logger.warn(`Could not rank the emojis of ${guild.id}: ${e.message}`)
      return []
    })
  const rank = new Map(first.map((id, i) => [id, i]))
  const ordered = selectProfileEmojis(ownEmojis, sharedEmojis, { rank, mentioned })
  return [
    `${head}。話に合いそうな順:`,
    ...ordered.map(e => formatEmojiNoteLine(e, notes))
  ]
}

const MAX_CONTEXT_FOR_SEARCH = 1500
const CONTEXT_WEIGHT = 0.6

// Whether a request (with its conversation) says enough to look anything up by meaning: at least
// MIN_SEARCH_CHARS characters once mentions, emojis, URLs, spaces and symbols are left out.
const MIN_SEARCH_CHARS = 5
function worthSearching (text) {
  const words = String(text || '')
    .replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+|:\w+:/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
  return [...words].length >= MIN_SEARCH_CHARS
}

// Messages of the server close in meaning to the request (`vector`), in channels the requester and
// the bot can read, for the server profile: lines. Only when stored messages are embedded
// (`vectorOf()` is asked for only then).
const MAX_RELATED_MESSAGES = 3
const MIN_MESSAGE_SCORE = 0.65
const MAX_RELATED_MESSAGE_CHARS = 120
async function relatedMessages (guild, member, vectorOf) {
  if (!messageEmbeddingsEnabled()) return []
  const channels = [...guild.channels.values()].filter(c => canRead(c, member) && canRead(c, global.bot.user.id))
  if (!channels.length) return []
  const vector = await vectorOf()
  if (!vector) return []
  const near = (await embeddingStore.nearestMessages(guild.id, channels.map(c => c.id), vector, { model: embeddingModel(), limit: MAX_RELATED_MESSAGES * 2 }))
    .filter(r => r.score >= MIN_MESSAGE_SCORE)
  const byID = new Map((await embeddingStore.getMessages(near.map(r => r.message_id))).map(m => [m.id, m]))
  return near.map(r => byID.get(r.message_id))
    .filter(m => m && m.author_id !== global.bot.user.id && embeddableText(fromStoredContent(m.content)))
    .slice(0, MAX_RELATED_MESSAGES)
    .map(m => {
      const who = guild.members.get(m.author_id)
      return `- ${formatJstDate(m.ts) || '?'} #${guild.channels.get(m.channel_id)?.name || m.channel_id} ${who ? displayName(who) : 'メンバー'}: ${fromStoredContent(m.content).replace(/\s+/g, ' ').slice(0, MAX_RELATED_MESSAGE_CHARS)}`
    })
}

// The server as the requester can see it. Sent with every request, fresh each time, so questions
// about "this server" need no lookups. query: what was asked; context: the conversation it replies
// to (readThread), if any. In a themed channel (e.g. #のばまんの動画について語る) without a reply
// thread, the channel's theme also steers which knowledge, lore, past talk and emojis come first.
// slim: for bare greetings, edits, or pure creative stories that do not touch server data, send
// only the server name, style, and compact emoji codes.
async function describeServer (guild, member, requestChannelID, { query = '', context = '', queryVector = null, slim = false, extraEmojis = null } = {}) {
  // Ensure the channel cache is readable before building the profile.
  guild.channels.values()
  const lines = [`サーバー名: ${guild.name}`]
  const sharedEmojis = Array.isArray(extraEmojis) ? extraEmojis : await sharedOwnerEmojis(guild, requestChannelID)
  const mentioned = mentionedEmojiIDs([query, context])
  if (slim) {
    const lore = serverLore.enabled()
      ? await serverLore.relatedLore(guild.id, () => Promise.resolve(null)).catch(() => ({ facts: [], style: null }))
      : { facts: [], style: null }
    if (lore.style) lines.push('', '### このサーバーのノリ（メンバーの会話から）', lore.style)
    const ownEmojis = usableEmojis(guild)
    const picked = selectProfileEmojis(ownEmojis, sharedEmojis, { mentioned })
    if (picked.length) {
      const head = '### サーバー絵文字（返事で使うときは、この書き方のまま書く）'
      const guildIDs = [...new Set([guild.id, ...sharedEmojis.map(e => e.guildID)].filter(Boolean))]
      const storeTarget = guildIDs.length === 1 ? guildIDs[0] : guildIDs
      const notes = mentioned.size && emojiDescriber.enabled()
        ? await emojiStore.descriptions(storeTarget).catch(() => ({}))
        : {}
      if ([...mentioned].some(id => notes[id])) {
        lines.push('', head, ...picked.map(e => formatEmojiNoteLine(e, notes)))
      } else {
        lines.push('', head, picked.map(emojiCode).join(' '))
      }
    }
    return lines.join('\n')
  }
  if (guild.description) lines.push(`説明: ${guild.description}`)
  if (guild.memberCount) lines.push(`メンバー数: ${guild.memberCount}`)
  if (guild.rulesChannelID) lines.push(`ルールチャンネル: <#${guild.rulesChannelID}>（内容は get_server_rules で読む）`)

  // What the knowledge and the emojis are chosen for: the request, and the conversation it replies
  // to, which counts more (a reply such as "それの続きは？" is about what came before). The latest
  // part of the conversation is used. Embedded once, when first needed, and only when there is
  // something to search with: a bare greeting or a few emojis ("おはよう", "w") need no lookup.
  const recent = String(context || '').slice(-MAX_CONTEXT_FOR_SEARCH)
  const theme = !recent.trim() ? channelTheme(requestChannelID, guild) : ''
  const texts = [recent, query].filter(t => t.trim())
  const searchable = worthSearching(texts.join('\n'))
  let embedding = null
  const vectorOf = () => {
    if (!searchable && !(theme && SHORT_TOPIC_PROMPT.test(query))) return Promise.resolve(null)
    if (!embedding) {
      embedding = (async () => {
        if (!searchable) return cachedThemeVector(theme)
        if (!recent.trim()) {
          const qPromise = typeof queryVector === 'function' ? Promise.resolve(queryVector()) : embedQuery(query)
          if (!theme) return qPromise
          const [qVec, tVec] = await Promise.all([qPromise, cachedThemeVector(theme)])
          return qVec && tVec ? blend([qVec, tVec], [1 - CHANNEL_THEME_WEIGHT, CHANNEL_THEME_WEIGHT]) : (qVec || tVec)
        }
        const vectors = await embed(texts, 'RETRIEVAL_QUERY')
        return vectors.length === 1 ? vectors[0] : blend(vectors, [CONTEXT_WEIGHT, 1 - CONTEXT_WEIGHT])
      })().catch(e => {
        global.logger.warn(`Could not embed the request in ${guild.id}: ${e.message}`)
        return null
      })
    }
    return embedding
  }
  const knowledgeText = [theme, ...texts].filter(Boolean).join('\n')
  const known = wikiKnowledge.searchable() ? await wikiKnowledge.relatedKnowledge(knowledgeText, await vectorOf()).catch(() => []) : []
  if (known.length) {
    lines.push('', '### コミュニティの知識（wiki と配信者の X より。依頼に関係しそうなもの）',
      'キャラクターが何者かはここ（と search_wiki）で確かめ、絵文字の説明（見た目）から決めつけないこと。', ...known)
  }

  const lore = await serverLore.relatedLore(guild.id, vectorOf).catch(() => ({ facts: [], style: null }))
  if (lore.style) lines.push('', '### このサーバーのノリ（メンバーの会話から）', lore.style)
  if (lore.facts.length) lines.push('', '### このサーバーのこと（メンバーの会話から。身内ネタ・用語・出来事など）', ...lore.facts)
  const said = await relatedMessages(guild, member, vectorOf).catch(() => [])
  if (said.length) lines.push('', '### このサーバーで前に出た、依頼に近い発言', ...said)

  const emojiLines = await emojiSection(guild, vectorOf, { sharedEmojis, mentioned })
  if (emojiLines.length) lines.push('', ...emojiLines)

  const youtube = await youtubeDB.getOverview(guild.id).catch(() => null)
  const synced = (youtube?.channels || []).filter(c => c.synced_at)
  lines.push('', '### YouTube', synced.length
    ? [
        ...synced.map(c => {
          const subs = formatCount(c.subscriber_count, '人')
          return `${c.title}（${subs ? `登録者 ${subs}、` : ''}動画 ${c.video_count} 件を保存、取得 ${new Date(c.synced_at).toISOString()}）`
        }),
        '詳しくは search_youtube で調べる（題名・公開日・再生数・配信日時・要約）'
      ].join('\n')
    : '設定なし')
  const twitch = await twitchDB.getOverview().catch(() => [])
  if (twitch.length) {
    lines.push('', '### Twitch', [
      ...twitch.map(c => `${c.display_name || c.login}（https://www.twitch.tv/${c.login}、アーカイブ ${c.video_count} 件を保存）`),
      '過去の配信は search_twitch で調べる'
    ].join('\n'))
  }
  const steam = await steamDB.getOverview().catch(() => [])
  if (steam.length) {
    lines.push('', '### Steam', [
      ...steam.map(p => `${p.persona_name || p.account_ref}（https://steamcommunity.com/${p.custom_url ? `id/${p.custom_url}` : `profiles/${p.steam_id}`}、所持・プレイ確認ゲーム ${p.stored_game_count} 本${p.game_count ? `／所持総数 ${p.game_count} 本` : ''}・レビュー ${p.review_count} 件・ウィッシュリスト ${p.stored_wishlist_count} 本を保存）`),
      '持っているゲーム・プレイ時間・レビュー・ウィッシュリスト・おすすめのゲームは search_steam で調べる'
    ].join('\n'))
  }
  return lines.join('\n')
}

module.exports = { worthSearching, createTools, formatMessage, formatVideo, inferVideoSort, describeServer, withServerEmojis, canUseExternalEmojis, sharedOwnerEmojis, withServerChannels, namedChannels, namedMembers, requestChannelInfo, channelTheme, SHORT_TOPIC_PROMPT, searchYouTube, searchTwitch, searchSteam, MESSAGE_LINK, CHANNEL_LINK, StopDrafting }
