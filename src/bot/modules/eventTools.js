const urlFetcher = require('../utils/urlFetcher')
const { describeForums } = require('./forumPost')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const twitchDB = require('../../db/interfaces/postgres/twitch')
const steamDB = require('../../db/interfaces/postgres/steam')
const messageDB = require('../../db/interfaces/postgres/read')
const videoSummary = require('./videoSummary')
const { linkTimestamps } = require('../utils/youtube')
const emojiDescriber = require('./emojiDescriber')
const wikiKnowledge = require('./wikiKnowledge')
const gameMentions = require('./gameMentions')
const gameLinks = require('./gameLinks')
const emojiStore = require('../../db/interfaces/postgres/emojis')
const { embed, blend, model: embeddingModel } = require('../utils/embeddings')
const { fromStoredContent } = require('../../db/interfaces/postgres/create')
const semanticSearch = require('./semanticSearch')
const { messageEmbeddingsEnabled } = require('./embeddingIndexer')
const { wrap, reportInjection } = require('../utils/untrusted')
const serverLore = require('./serverLore')
const serverRules = require('./serverRules')
const loreStore = require('../../db/interfaces/postgres/serverLore')
const embeddingStore = require('../../db/interfaces/postgres/embeddings')
const { embeddableText } = require('../utils/messageNoise')

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
    description: 'Web ページの本文・タイトル・メタ情報・JSON-LD をテキストで取得する。Discord のメッセージリンクには使わず get_discord_message を使う。',
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
    description: 'このサーバーに設定された YouTube チャンネルについて保存している情報（チャンネル概要、最近の動画、配信予定・配信中）を探す。動画・配信・チャンネルについての依頼で使う。query を省くと新しい順に返す。',
    parameters: {
      type: 'OBJECT',
      properties: { query: { type: 'STRING', description: '題名・説明に含まれる語（空白区切りで AND）' } }
    }
  },
  {
    name: 'search_twitch',
    description: 'BOT が見ている Twitch チャンネルの過去の配信（アーカイブ）を探す。題名・配信日・長さ・リンクが分かる（中で話した内容は分からない）。Twitch の配信やアーカイブについての依頼で使う。query を省くと新しい順に返す。',
    parameters: {
      type: 'OBJECT',
      properties: { query: { type: 'STRING', description: '題名・説明に含まれる語（空白区切りで AND）' } }
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
const MAX_PROFILE_EMOJIS = 15
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
      messages.unshift(m.id ? m : { ...m, id: next.messageID })
      next = m.messageReference && { channelID: m.messageReference.channelID || next.channelID, messageID: m.messageReference.messageID }
    }
    return {
      text: messages.map(m => formatMessage(m, member.id)).join('\n'),
      count: messages.length,
      // The conversation without the bot's own replies: what knowledge is looked up by
      // (describeServer), so the bot's earlier answers do not keep bringing back the same
      // knowledge, and with it the same jokes.
      othersText: messages.filter(m => m.author?.id !== global.bot.user.id).map(m => formatMessage(m, member.id)).join('\n'),
      messageIds: messages.map(m => m.id).filter(Boolean)
    }
  }

  const executors = {
    async fetch_url ({ url }) {
      if (MESSAGE_LINK.test(url) || CHANNEL_LINK.test(url)) return executors.get_discord_message({ link: url })
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
      const channel = readableChannel(channelID)
      const count = Math.min(Math.max(parseInt(limit, 10) || 20, 1), MAX_RECENT_MESSAGES)
      const messages = await global.bot.getMessages(channelID, { limit: count })
      sources.push(`<#${channel.id}>`)
      return messages.filter(Boolean).map(m => formatMessage(m)).join('\n') // null: one Eris could not read
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
      const all = [...guild.channels.values()]
      const order = c => [guild.channels.get(c.parentID)?.position ?? -1, c.position ?? 0]
      return all
        .filter(c => c.type !== 4 && c.permissionsOf(member.id).has('viewChannel'))
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
    async search_youtube ({ query }) {
      return searchYouTube(guild.id, query)
    },
    async search_twitch ({ query }) {
      return searchTwitch(query)
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
      const channels = [...guild.channels.values()].filter(c => canRead(c, member.id) && canRead(c, global.bot.user.id))
      // The stored messages only where reading them for this is declared (SERVER_LORE, serverLore.js).
      const messages = serverLore.enabled() && channels.length ? await loreStore.memberMessages(guild.id, m.id, channels.map(c => c.id), MAX_MEMBER_MESSAGES) : []
      const channelName = id => guild.channels.get(id)?.name || id
      return [
        `表示名: ${displayName(m)}（@${m.username}、ID: ${m.id}）${m.bot ? '（BOT）' : ''}`,
        `ロール: ${roles.join(', ') || 'なし'}`,
        m.joinedAt ? `サーバーに参加: ${new Date(m.joinedAt).toISOString().slice(0, 10)}` : '',
        '',
        messages.length
          ? [`最近の発言（新しい順、依頼者が読めるチャンネルのもの ${messages.length} 件）:`, ...messages.map(r => `[${new Date(r.ts).toISOString().slice(0, 10)}] #${channelName(r.channel_id)}: ${fromStoredContent(r.content).replace(/\s+/g, ' ').slice(0, MAX_HISTORY_TEXT / 2)}`)].join('\n')
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
      return `${link} の内容の要約${cached ? '（保存済み）' : ''}:\n${linkTimestamps(summary, videoID)}`
    }
  }

  // Errors go back to the model as the tool result, so it can tell the user what it couldn't read
  // instead of the whole draft failing.
  async function call (name, args) {
    if (!executors[name]) return { error: `不明なツールです: ${name}` }
    try {
      const result = String(await executors[name](args || {})).slice(0, MAX_RESULT_CHARS)
      reportInjection(`the ${name} result in ${guild.id}`, result)
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

  if (!knowledge) return ['BOT が見ている YouTube チャンネルはありません', ...otherLines].join('\n')
  const { videos } = knowledge
  const channels = (knowledge.channels || [knowledge.channel]).filter(c => c.synced_at)
  if (!channels.length) return ['YouTube チャンネルはまだ情報を取得していません（しばらくすると自動で取得されます）', ...otherLines].join('\n')
  const channelName = new Map(channels.map(c => [c.channel_id, c.title]))
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
    ...channels.map(c => `チャンネル: ${c.title}（${c.url}、取得 ${new Date(c.synced_at).toISOString()}）${c.description ? `\n  概要: ${c.description.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`),
    `保存している動画 ${videos.length} 件、うち内容の要約あり ${videos.filter(v => v.summary).length} 件`,
    ranked
      ? `「${query}」に意味が近い順の動画（語をすべて含むもの ${matches.length} 件を優先）:`
      : words.length ? `「${query}」に一致した動画: ${matches.length} 件` : '新しい順の動画:',
    ...ordered.slice(0, MAX_YOUTUBE_RESULTS).map(v => channels.length > 1 && channelName.get(v.channel_id) ? formatVideo(v).replace(/^- /, `- 【${channelName.get(v.channel_id)}】`) : formatVideo(v)),
    ...(!ranked && matches.length > MAX_YOUTUBE_RESULTS ? [`…ほか ${matches.length - MAX_YOUTUBE_RESULTS} 件（query で絞り込めます）`] : []),
    ...otherLines
  ].filter(Boolean).join('\n')
}

// The Twitch archives (twitchSync.js) that have every word of `query` in their title or
// description, newest first.
async function searchTwitch (query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  const [channels, archives] = await Promise.all([twitchDB.getOverview(), twitchDB.getArchives()])
  if (!channels.length) return 'BOT が見ている Twitch チャンネルはありません'
  const matches = archives.filter(v => matchesAll(words, `${v.title}\n${v.description || ''}`))
  const line = v => {
    const date = v.published_at ? new Date(v.published_at).toISOString().slice(0, 10) : '?'
    const who = channels.length > 1 ? `【${v.display_name || v.login}】` : ''
    return `- ${who}${v.title}（配信 ${date}${v.duration ? `、長さ ${v.duration}` : ''}）${v.url}`
  }
  return [
    ...channels.map(c => `チャンネル: ${c.display_name || c.login}（https://www.twitch.tv/${c.login}、アーカイブ ${c.video_count} 件${c.synced_at ? `、取得 ${new Date(c.synced_at).toISOString()}` : '、まだ取得していない'}）${c.description ? `\n  概要: ${c.description.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`),
    'Twitch はアーカイブを一定期間（7〜60日）で消すため、古い配信は残っていない。',
    words.length ? `「${query}」に一致したアーカイブ: ${matches.length} 件` : '新しい順のアーカイブ:',
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
    const first = g.first_played_at ? `、初プレイ ${new Date(g.first_played_at).toISOString().slice(0, 10)}` : ''
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
    const added = w.added_at ? `（追加 ${new Date(w.added_at).toISOString().slice(0, 10)}）` : ''
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

// The model sometimes writes a server emoji as :name: rather than its code, puts codes in ` (code
// formatting, where Discord shows them as text), or gets the ID or the a: of an animated one
// wrong. Emojis the server has are written as their exact code, outside code formatting; others
// are left as written.
const EMOJI = '(?:<a?:\\w{2,32}:\\d+>|:\\w{2,32}:)'
const CODED_EMOJIS = new RegExp(`(\`{1,3})\\s*(${EMOJI}(?:\\s*${EMOJI})*)\\s*\\1`, 'g')
function withServerEmojis (text, guild) {
  const emojis = usableEmojis(guild)
  const byName = new Map(emojis.map(e => [e.name, e]))
  const byID = new Map(emojis.map(e => [e.id, e]))
  const find = (name, id, bare) => bare ? byName.get(bare) : (byID.get(id) || byName.get(name))
  const ONE = /<(a?):(\w{2,32}):(\d+)>|:(\w{2,32}):/g
  return text
    // Only when every emoji inside is the server's: anything else in ` may be meant as code.
    .replace(CODED_EMOJIS, (whole, ticks, inside) => [...inside.matchAll(ONE)].every(m => find(m[2], m[3], m[4])) ? inside : whole)
    .replace(ONE, (whole, animated, name, id, bare) => {
      const emoji = find(name, id, bare)
      return emoji ? emojiCode(emoji) : whole
    })
}

// The model sometimes writes a channel as #name rather than <#ID>, which Discord shows as a link.
// Names of channels the requester can see are turned into links; anything else is left as written
// (a hashtag, a URL fragment, <#ID> already).
function withServerChannels (text, guild, member) {
  const channels = [...guild.channels.values()]
    .filter(c => c.type !== 4 && c.name && c.permissionsOf(member.id).has('viewChannel'))
    .sort((a, b) => b.name.length - a.name.length)
  if (!channels.length) return text
  const byName = new Map(channels.map(c => [c.name, c]))
  const names = [...byName.keys()].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_/<&=-])#(${names.join('|')})(?![\\p{L}\\p{N}_-])`, 'gu')
  return text.replace(pattern, (whole, name) => `<#${byName.get(name).id}>`)
}

// What the channel a request was made in is, for "このチャンネルについて教えて": its name, kind,
// category (or, for a thread, the channel it is in) and description. Null when unknown.
function requestChannelInfo (channelID, guild) {
  const c = global.bot.getChannel?.(channelID)
  if (!c || (c.guild?.id && c.guild.id !== guild.id)) return null
  const parent = c.parentID ? guild.channels.get(c.parentID) || global.bot.getChannel?.(c.parentID) : null
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
    .filter(c => c && c.permissionsOf(member.id).has('viewChannel'))
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

// The server's emojis for the model. With descriptions (emojiDescriber.js), one per line with what
// it shows and when to use it, those closest in meaning to the request first (`vectorOf()`
// resolves to its embedding, or null); otherwise just the codes.
async function emojiSection (guild, vectorOf) {
  const emojis = usableEmojis(guild)
  if (!emojis.length) return []
  const head = '### サーバー絵文字（返事で使うときは、この書き方のまま書く）'
  const notes = emojiDescriber.enabled() ? await emojiStore.descriptions(guild.id).catch(() => ({})) : {}
  if (!Object.keys(notes).length) return [head, emojis.slice(0, MAX_PROFILE_EMOJIS).map(emojiCode).join(' ')]
  const vector = await vectorOf()
  if (!vector) return [head, emojis.slice(0, MAX_PROFILE_EMOJIS).map(emojiCode).join(' ')]
  const first = await emojiStore.nearestEmojis(guild.id, vector, embeddingModel(), MAX_PROFILE_EMOJIS)
    .catch(e => {
      global.logger.warn(`Could not rank the emojis of ${guild.id}: ${e.message}`)
      return []
    })
  const rank = new Map(first.map((id, i) => [id, i]))
  const ordered = [...emojis].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
  return [
    `${head}。話に合いそうな順:`,
    ...ordered.slice(0, MAX_PROFILE_EMOJIS).map(e => notes[e.id] ? `- ${emojiCode(e)} ${notes[e.id]}` : `- ${emojiCode(e)}`)
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
const MAX_RELATED_MESSAGES = 5
const MIN_MESSAGE_SCORE = 0.6
async function relatedMessages (guild, member, vectorOf) {
  if (!messageEmbeddingsEnabled()) return []
  const channels = [...guild.channels.values()].filter(c => canRead(c, member.id) && canRead(c, global.bot.user.id))
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
      return `- ${new Date(m.ts).toISOString().slice(0, 10)} #${guild.channels.get(m.channel_id)?.name || m.channel_id} ${who ? displayName(who) : 'メンバー'}: ${fromStoredContent(m.content).replace(/\s+/g, ' ').slice(0, 150)}`
    })
}

// The server as the requester can see it. Sent with every request, fresh each time, so questions
// about "this server" need no lookups. query: what was asked; context: the conversation it replies
// to (readThread), if any. Both choose the knowledge and the emojis put first.
async function describeServer (guild, member, requestChannelID, { query = '', context = '', queryVector = null } = {}) {
  // Ensure the channel cache is readable before building the profile.
  guild.channels.values()
  const lines = [`サーバー名: ${guild.name}`]
  if (guild.description) lines.push(`説明: ${guild.description}`)
  if (guild.memberCount) lines.push(`メンバー数: ${guild.memberCount}`)
  if (guild.rulesChannelID) lines.push(`ルールチャンネル: <#${guild.rulesChannelID}>（内容は get_server_rules で読む）`)

  // What the knowledge and the emojis are chosen for: the request, and the conversation it replies
  // to, which counts more (a reply such as "それの続きは？" is about what came before). The latest
  // part of the conversation is used. Embedded once, when first needed, and only when there is
  // something to search with: a bare greeting or a few emojis ("おはよう", "w") need no lookup.
  const recent = String(context || '').slice(-MAX_CONTEXT_FOR_SEARCH)
  const texts = [recent, query].filter(t => t.trim())
  let embedding = null
  const vectorOf = () => {
    if (!worthSearching(texts.join('\n'))) return Promise.resolve(null)
    if (!embedding) {
      if (!recent.trim() && typeof queryVector === 'function') {
        embedding = Promise.resolve(queryVector()).catch(e => {
          global.logger.warn(`Could not embed the request in ${guild.id}: ${e.message}`)
          return null
        })
      } else {
        embedding = embed(texts, 'RETRIEVAL_QUERY')
          .then(vectors => vectors.length === 1 ? vectors[0] : blend(vectors, [CONTEXT_WEIGHT, 1 - CONTEXT_WEIGHT]))
          .catch(e => {
            global.logger.warn(`Could not embed the request in ${guild.id}: ${e.message}`)
            return null
          })
      }
    }
    return embedding
  }
  const known = wikiKnowledge.searchable() ? await wikiKnowledge.relatedKnowledge(texts.join('\n'), await vectorOf()).catch(() => []) : []
  if (known.length) {
    lines.push('', '### コミュニティの知識（wiki と配信者の X より。依頼に関係しそうなもの）',
      'キャラクターが何者かはここ（と search_wiki）で確かめ、絵文字の説明（見た目）から決めつけないこと。', ...known)
  }

  const lore = await serverLore.relatedLore(guild.id, vectorOf).catch(() => ({ facts: [], style: null }))
  if (lore.style) lines.push('', '### このサーバーのノリ（メンバーの会話から）', lore.style)
  if (lore.facts.length) lines.push('', '### このサーバーのこと（メンバーの会話から。身内ネタ・用語・出来事など）', ...lore.facts)
  const said = await relatedMessages(guild, member, vectorOf).catch(() => [])
  if (said.length) lines.push('', '### このサーバーで前に出た、依頼に近い発言', ...said)

  const emojiLines = await emojiSection(guild, vectorOf)
  if (emojiLines.length) lines.push('', ...emojiLines)

  const youtube = await youtubeDB.getOverview(guild.id).catch(() => null)
  const synced = (youtube?.channels || []).filter(c => c.synced_at)
  lines.push('', '### YouTube', synced.length
    ? [
        ...synced.map(c => `${c.title}（動画 ${c.video_count} 件を保存、取得 ${new Date(c.synced_at).toISOString()}）`),
        '詳しくは search_youtube で調べる'
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

module.exports = { worthSearching, createTools, formatMessage, describeServer, withServerEmojis, withServerChannels, namedChannels, namedMembers, requestChannelInfo, searchYouTube, searchTwitch, searchSteam, MESSAGE_LINK, CHANNEL_LINK, StopDrafting }
