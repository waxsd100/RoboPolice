// Stand-ins for the parts of Eris, Discord and Gemini the event drafting code touches. They record
// what the code did so tests can assert on it.
const http = require('http')

process.env.AES_KEY = process.env.AES_KEY || 'test-aes-key'
// The knowledge features have defaults for the real community (knowledgeDefaults.js); tests turn
// them off unless they set one.
for (const name of ['WIKI_URLS', 'TWITTER_ACCOUNTS', 'DISCORD_KNOWLEDGE_USERS', 'KNOWLEDGE_TOPICS', 'YOUTUBE_CHANNELS']) process.env[name] ??= ''
global.logger = global.logger || { info () {}, warn () {}, error () {}, debug () {}, startup () {}, fatal () {} }
global.webhook = global.webhook || { generic () {}, warn () {}, error () {}, fatal () {} }

const READ = ['viewChannel', 'readMessageHistory']

function perms (names) {
  return { has: name => names.includes(name), json: Object.fromEntries(names.map(n => [n, true])) }
}

// channels: [{ id, name, type, readers: [userID], posters: [userID], moderators: [userID] }]
function createGuild ({ id = '100', ownerID = '900', channels = [], botPerms = ['manageEvents'] } = {}) {
  const guild = { id, name: 'テストサーバー', memberCount: 42, ownerID, roles: new Map(), members: new Map(), channels: new Map() }
  guild.members.set('BOT', { id: 'BOT', permissions: perms(botPerms) })
  for (const c of channels) {
    guild.channels.set(c.id, {
      id: c.id,
      name: c.name,
      type: c.type ?? 0,
      guild,
      permissionsOf: userID => perms([
        ...((c.readers || []).includes(userID) ? READ : []),
        ...((c.posters || []).includes(userID) ? ['viewChannel', 'sendMessages'] : []),
        ...((c.moderators || []).includes(userID) ? ['manageThreads'] : [])
      ])
    })
  }
  return guild
}

function createMember ({ id = '1', permissions = ['manageEvents'], roles = [] } = {}) {
  return { id, roles, permissions: perms(permissions) }
}

// messages: { 'channelID/messageID': { content, author, ... } }
// forums: { channelID: { available_tags, flags, topic } } as GET /channels/:id returns them
function installBot ({ guilds = [], messages = {}, scheduledEvents = [], forums = {} } = {}) {
  const calls = []
  global.bot = {
    user: { id: 'BOT' },
    getChannel (id) {
      for (const g of guilds) if (g.channels.has(id)) return g.channels.get(id)
      return undefined
    },
    async getMessage (channelID, messageID) {
      const m = messages[`${channelID}/${messageID}`]
      if (!m) throw new Error('Unknown Message')
      return { timestamp: 0, embeds: [], attachments: [], author: { id: '2', username: 'alice' }, ...m }
    },
    async getMessages (channelID, { limit }) {
      calls.push({ getMessages: channelID, limit })
      return Object.entries(messages)
        .filter(([key]) => key.startsWith(`${channelID}/`))
        .map(([, m]) => ({ timestamp: 0, embeds: [], attachments: [], author: { id: '2', username: 'alice' }, ...m }))
        .slice(0, limit)
    },
    requestHandler: {
      async request (method, url, auth, body, files) {
        calls.push({ method, url, body, files })
        const forum = url.match(/^\/channels\/(\d+)$/)
        if (method === 'GET' && forum) return { id: forum[1], type: 15, ...forums[forum[1]] }
        if (method === 'GET') return scheduledEvents
        if (url.endsWith('/threads')) return { id: 'THREAD1', ...body }
        return { id: 'EVENT1', ...body }
      }
    }
  }
  return calls
}

// Replaces the embedding store with an in-memory one. videos: { guildID: { videoID: base64 } };
// messages: [{ message_id, guild_id, channel_id, ts, embedding (base64), author_id, content }]
// where content is the stored (escaped, unencrypted here) text.
function installEmbeddingStore ({ videos = {}, messages = [], pending = [] } = {}) {
  const store = require('../../src/db/interfaces/postgres/embeddings')
  const saved = { videos: [], messages: [], handled: [], invalidated: [] }
  const { similarity, fromBase64 } = require('../../src/bot/utils/embeddings')
  store.hasVideoEmbeddings = async guildID => Object.keys(videos[guildID] || {}).length !== 0
  store.videoScores = async (guildID, q) => Object.fromEntries(Object.entries(videos[guildID] || {}).map(([id, e]) => [id, similarity(q, fromBase64(e))]))
  store.resetStaleMessageEmbeddings = async (model) => {
    saved.resetFor = model
    return 0
  }
  store.videosForEmbedding = async () => []
  store.saveVideoEmbedding = async (videoID, embedding, hash, model) => saved.videos.push({ videoID, embedding, hash, model })
  store.pendingMessages = async limit => pending.slice(0, limit)
  store.saveMessageEmbeddings = async (rows, handled) => {
    saved.messages.push(...rows)
    saved.handled.push(...handled)
  }
  store.invalidateMessage = async id => saved.invalidated.push(id)
  store.nearestMessages = async (guildID, channelIDs, q, { limit = 60 } = {}) => messages
    .filter(m => m.guild_id === guildID && channelIDs.includes(m.channel_id))
    .map(m => ({ message_id: m.message_id, score: similarity(q, fromBase64(m.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  store.getMessages = async ids => messages.filter(m => ids.includes(m.message_id))
    .map(m => ({ id: m.message_id, author_id: m.author_id, channel_id: m.channel_id, ts: m.ts, content: m.content }))
  return saved
}

// Replaces the Redis counter behind the daily mention limit with an in-memory one.
function installQuotaStore () {
  const counts = new Map()
  const { store } = require('../../src/bot/utils/mentionQuota')
  store.increment = async key => {
    counts.set(key, (counts.get(key) || 0) + 1)
    return counts.get(key)
  }
  store.decrement = async key => counts.set(key, (counts.get(key) || 0) - 1)
  return counts
}

// Replaces the YouTube store with an in-memory one, so no test reaches a real database.
// knowledge: { guildID: { channel, videos } }: each entry's channel is one the bot follows (the same
// channel may appear for several servers), and channel.live_events is that server's setting.
// summaries: { guildID: { videoID: summary } } (a summary made for any server is found for all).
function installYouTubeStore (knowledge = {}, summaries = {}) {
  // No embeddings unless a test installs some: YouTube search falls back to keywords.
  installEmbeddingStore()
  const store = require('../../src/db/interfaces/postgres/youtube')
  const writes = []
  const liveSettings = {}
  const anySummary = videoID => Object.values(summaries).find(s => s[videoID])?.[videoID] || null
  // A channel given without its ID gets one, so it can be told apart.
  const idOf = guildID => knowledge[guildID].channel.channel_id || `UC-unset-${guildID}`
  const channels = () => [...new Map(Object.keys(knowledge).filter(g => knowledge[g].channel).map(g => [idOf(g), { ...knowledge[g].channel, channel_id: idOf(g) }])).values()]
  const videosOf = g => (knowledge[g].videos || []).map((v, i) => ({ channel_id: idOf(g), video_id: v.video_id || `${g}-${i}`, ...v }))
  const allVideos = () => [...new Map(Object.keys(knowledge).filter(g => knowledge[g].channel).flatMap(videosOf).map(v => [v.video_id, v])).values()]
    .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0))
  const liveOn = guildID => !!(liveSettings[guildID] ?? knowledge[guildID]?.channel?.live_events)
  store.listChannels = async () => channels()
  store.setBotChannels = async list => { writes.push({ setBotChannels: list }) }
  store.getKnowledge = async guildID => {
    if (!channels().length) return null
    return { channels: channels(), channel: knowledge[guildID]?.channel || channels()[0], videos: allVideos().map(v => ({ ...v, summary: anySummary(v.video_id) || v.summary || null })), live_events: liveOn(guildID) }
  }
  store.getVideoIds = async (channelID = null) => new Set(allVideos().filter(v => !channelID || v.channel_id === channelID).map(v => v.video_id))
  store.getOverview = async guildID => {
    if (!channels().length) return null
    const list = channels().map(c => {
      const vs = allVideos().filter(v => v.channel_id === c.channel_id)
      return { ...c, video_count: vs.length, summary_count: vs.filter(v => anySummary(v.video_id)).length, live_count: vs.filter(v => ['live', 'upcoming'].includes(v.live_status)).length }
    })
    const sum = key => list.reduce((n, c) => n + c[key], 0)
    return { channels: list, video_count: sum('video_count'), summary_count: sum('summary_count'), live_count: sum('live_count'), live_events: liveOn(guildID) }
  }
  store.listLiveEventGuilds = async () => [...new Set([...Object.keys(knowledge), ...Object.keys(liveSettings)])].filter(liveOn)
  store.liveEventsOn = async guildID => liveOn(guildID)
  const liveEvents = {}
  // Tries to summarize each stream's archive, per video (the summary is shared by every server).
  const archiveAttempts = {}
  store.setLiveEvents = async (guildID, enabled) => {
    writes.push({ setLiveEvents: [guildID, enabled] })
    liveSettings[guildID] = enabled
  }
  // The entries of the channel, where its videos are kept.
  const entriesOf = channelID => Object.keys(knowledge).filter(g => knowledge[g].channel && idOf(g) === channelID).map(g => knowledge[g])
  store.upsertVideos = async (channelID, videos) => {
    writes.push({ upsertVideos: channelID, videos: videos.map(v => v.id) })
    for (const k of entriesOf(channelID)) {
      const byID = new Map((k.videos || []).map(v => [v.video_id, v]))
      for (const v of videos) byID.set(v.id, { ...byID.get(v.id), video_id: v.id, title: v.title, live_status: v.liveStatus, scheduled_start: v.scheduledStart, published_at: v.publishedAt, url: v.url })
      k.videos = [...byID.values()]
    }
  }
  store.recentVideoIds = async (channelID, since) => allVideos().filter(v => v.channel_id === channelID && v.published_at && new Date(v.published_at) > since).map(v => v.video_id)
  store.getLiveVideoIds = async channelID => allVideos().filter(v => (!channelID || v.channel_id === channelID) && ['live', 'upcoming'].includes(v.live_status)).map(v => v.video_id)
  store.getLiveEvents = async guildID => ({ ...(liveEvents[guildID] || {}) })
  store.saveLiveEvent = async (guildID, videoID, { eventID, status, scheduledStart, scheduledEnd, kind = 'stream' }) => {
    liveEvents[guildID] = liveEvents[guildID] || {}
    const before = liveEvents[guildID][videoID]
    liveEvents[guildID][videoID] = { ...before, event_id: eventID, status, kind: before?.kind || kind, scheduled_start: scheduledStart, scheduled_end: scheduledEnd }
  }
  // Any completed stream without a summary is due (the store also waits after it ends and between tries).
  store.archivesToSummarize = async guildID => Object.entries(liveEvents[guildID] || {})
    .filter(([id, e]) => e.kind !== 'upload' && e.status === 'completed' && (archiveAttempts[id] || 0) < 3 && !Object.values(summaries).some(s => s[id]))
    .slice(0, 1)
    .map(([id]) => ({ video_id: id, url: `https://www.youtube.com/watch?v=${id}` }))
  store.recordArchiveAttempt = async videoID => { archiveAttempts[videoID] = (archiveAttempts[videoID] || 0) + 1 }
  store.saveSync = async ({ channel, videos, backfillToken = null }) => {
    writes.push({ saveSync: channel.id, videos: videos.map(v => v.id), backfillToken })
    for (const k of entriesOf(channel.id)) {
      const byID = new Map((k.videos || []).map(v => [v.video_id, v]))
      for (const v of videos) {
        byID.set(v.id, { video_id: v.id, title: v.title, description: v.description, published_at: v.publishedAt, live_status: v.liveStatus, scheduled_start: v.scheduledStart, duration: v.duration, url: v.url })
      }
      Object.assign(k.channel, { channel_id: channel.id, title: channel.title, description: channel.description, handle: channel.handle, url: channel.url, backfill_token: backfillToken, synced_at: new Date('2026-10-29T12:00:00Z') })
      k.videos = [...byID.values()].sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    }
  }
  // Summaries are shared: one made for any server is found for all.
  store.getSummary = async videoID => anySummary(videoID)
  store.videoCards = async ids => Object.values(knowledge).flatMap(k => (k.videos || []).map(v => ({ video_id: v.video_id, title: v.title, channel_title: k.channel?.title || null })))
    .filter(v => ids.includes(v.video_id))
  store.videoDuration = async videoID => allVideos().find(v => v.video_id === videoID)?.duration || null
  store.saveSummary = async (guildID, videoID, summary = null) => {
    writes.push({ saveSummary: [guildID, videoID] })
    summaries[guildID] = { ...summaries[guildID], [videoID]: summary ?? await store.getSummary(videoID) }
  }
  store.getOtherSummaries = async guildID => {
    const own = new Set(allVideos().map(v => v.video_id))
    return Object.entries(summaries[guildID] || {}).filter(([id]) => !own.has(id)).map(([videoID, summary]) => ({ video_id: videoID, summary }))
  }
  store.deleteGuildYouTube = async guildID => {
    delete liveSettings[guildID]
    delete summaries[guildID]
    if (knowledge[guildID]?.channel) knowledge[guildID].channel.live_events = false
  }
  return { knowledge, summaries, writes, liveEvents, archiveAttempts }
}

function configureGateway () {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'
  process.env.CLOUDFLARE_AI_GATEWAY_ID = 'gw'
  process.env.GEMINI_API_KEY = 'gemini-key'
  delete process.env.CLOUDFLARE_AI_GATEWAY_TOKEN
  delete process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_MAX_STEPS
  delete process.env.GEMINI_TEMPERATURE
}

// A fake Gemini. `turns` is a list of model turns; each is an array of parts, or a function that
// receives the request body and returns parts (to answer based on what the tools returned).
function installGemini (turns) {
  const requests = []
  let i = 0
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ url, headers: init.headers, body, dispatcher: init.dispatcher })
    const turn = turns[i++]
    if (turn === undefined) throw new Error(`fake Gemini: no scripted turn ${i}`)
    if (turn instanceof Error) {
      return { ok: false, status: 500, text: async () => turn.message }
    }
    const parts = typeof turn === 'function' ? turn(body) : turn
    return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts } }] }) }
  }
  return requests
}

const call = (name, args = {}) => ({ functionCall: { name, args } })
const submit = args => call('submit_event_draft', { found: true, ...args })

// Tool responses the model received in the last request.
function lastToolResponses (body) {
  const last = body.contents[body.contents.length - 1]
  return last.parts.filter(p => p.functionResponse).map(p => p.functionResponse)
}

async function startServer (handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

module.exports = {
  perms, createGuild, createMember, installBot, installYouTubeStore, installQuotaStore, installEmbeddingStore, configureGateway, installGemini, call, submit, lastToolResponses, startServer
}

// A fake embedding model: each text points along the axis of the first topic it mentions, so
// texts about the same topic are close whatever their wording. Records every batch.
const TOPICS = [['ホラー', '怖い', 'こわい'], ['マイクラ', 'minecraft', '建築'], ['歌', 'カラオケ', 'singing']]
function installEmbeddingModel () {
  const batches = []
  global.fetch = async (url, init) => {
    if (!String(url).endsWith(':batchEmbedContents')) throw new Error(`unexpected request ${url}`)
    const body = JSON.parse(init.body)
    batches.push(body)
    return {
      ok: true,
      json: async () => ({
        embeddings: body.requests.map(r => {
          const text = r.content.parts[0].text.toLowerCase()
          const topic = TOPICS.findIndex(words => words.some(w => text.includes(w)))
          const values = new Array(r.outputDimensionality).fill(0)
          values[topic === -1 ? TOPICS.length : topic] = 1
          values[TOPICS.length + 1] = 0.1 // so no vector is all zeros
          return { values }
        })
      })
    }
  }
  return batches
}

module.exports.installEmbeddingModel = installEmbeddingModel
