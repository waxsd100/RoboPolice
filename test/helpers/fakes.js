// Stand-ins for the parts of Eris, Discord and Gemini the event drafting code touches. They record
// what the code did so tests can assert on it.
const http = require('http')

process.env.AES_KEY = process.env.AES_KEY || 'test-aes-key'
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
  store.ensureTables = async () => {}
  store.videoEmbeddings = async guildID => videos[guildID] || {}
  store.resetStaleMessageEmbeddings = async (model) => {
    saved.resetFor = model
    return 0
  }
  store.videosForEmbedding = async () => []
  store.saveVideoEmbedding = async (guildID, videoID, embedding, hash, model) => saved.videos.push({ guildID, videoID, embedding, hash, model })
  store.pendingMessages = async limit => pending.slice(0, limit)
  store.saveMessageEmbeddings = async (rows, handled) => {
    saved.messages.push(...rows)
    saved.handled.push(...handled)
  }
  store.invalidateMessage = async id => saved.invalidated.push(id)
  store.messageEmbeddingPages = async function * (guildID, channelIDs) {
    yield messages.filter(m => m.guild_id === guildID && channelIDs.includes(m.channel_id))
  }
  store.getMessages = async ids => messages.filter(m => ids.includes(m.message_id))
    .map(m => ({ id: m.message_id, author_id: m.author_id, channel_id: m.channel_id, ts: m.ts, content: m.content }))
  return saved
}

// Replaces the Redis counter behind the daily mention limit with an in-memory one.
function installQuotaStore () {
  const counts = new Map()
  require('../../src/bot/utils/mentionQuota').store.increment = async key => {
    counts.set(key, (counts.get(key) || 0) + 1)
    return counts.get(key)
  }
  return counts
}

// Replaces the YouTube store with an in-memory one, so no test reaches a real database.
// knowledge: { guildID: { channel, videos } } as getKnowledge() returns it; summaries:
// { guildID: { videoID: summary } }.
function installYouTubeStore (knowledge = {}, summaries = {}) {
  // No embeddings unless a test installs some: YouTube search falls back to keywords.
  installEmbeddingStore()
  const store = require('../../src/db/interfaces/postgres/youtube')
  const writes = []
  const withSummaries = guildID => knowledge[guildID] && {
    ...knowledge[guildID],
    videos: knowledge[guildID].videos.map(v => ({ ...v, summary: summaries[guildID]?.[v.video_id] || v.summary || null }))
  }
  store.ensureTables = async () => {}
  store.getKnowledge = async guildID => withSummaries(guildID) || null
  store.getVideoIds = async guildID => new Set((knowledge[guildID]?.videos || []).map(v => v.video_id))
  store.setChannel = async (guildID, ref, channelID) => {
    writes.push({ setChannel: [guildID, ref, channelID] })
    if (knowledge[guildID] && knowledge[guildID].channel.channel_id === channelID) {
      knowledge[guildID].channel.channel_ref = ref
      return
    }
    knowledge[guildID] = { channel: { guild_id: guildID, channel_ref: ref, channel_id: channelID, synced_at: null, backfill_token: null }, videos: [] }
  }
  store.getOverview = async guildID => knowledge[guildID] && {
    ...knowledge[guildID].channel,
    video_count: knowledge[guildID].videos.length,
    summary_count: Object.keys(summaries[guildID] || {}).length,
    live_count: knowledge[guildID].videos.filter(v => ['live', 'upcoming'].includes(v.live_status)).length
  }
  store.listChannels = async () => Object.entries(knowledge)
    .filter(([, k]) => k.channel.channel_id)
    .map(([guildID, k]) => ({ guild_id: guildID, channel_id: k.channel.channel_id, live_events: !!k.channel.live_events }))
  const liveEvents = {}
  store.setLiveEvents = async (guildID, enabled) => {
    writes.push({ setLiveEvents: [guildID, enabled] })
    knowledge[guildID].channel.live_events = enabled
  }
  store.upsertVideos = async (guildID, videos) => {
    writes.push({ upsertVideos: guildID, videos: videos.map(v => v.id) })
    const byID = new Map((knowledge[guildID]?.videos || []).map(v => [v.video_id, v]))
    for (const v of videos) byID.set(v.id, { ...byID.get(v.id), video_id: v.id, title: v.title, live_status: v.liveStatus, scheduled_start: v.scheduledStart, url: v.url })
    if (knowledge[guildID]) knowledge[guildID].videos = [...byID.values()]
  }
  store.getLiveVideoIds = async guildID => (knowledge[guildID]?.videos || []).filter(v => ['live', 'upcoming'].includes(v.live_status)).map(v => v.video_id)
  store.getLiveEvents = async guildID => ({ ...(liveEvents[guildID] || {}) })
  store.saveLiveEvent = async (guildID, videoID, { eventID, status, scheduledStart, scheduledEnd }) => {
    liveEvents[guildID] = liveEvents[guildID] || {}
    liveEvents[guildID][videoID] = { event_id: eventID, status, scheduled_start: scheduledStart, scheduled_end: scheduledEnd }
  }
  store.saveSync = async (guildID, { channel, videos, backfillToken = null }) => {
    writes.push({ saveSync: guildID, videos: videos.map(v => v.id), backfillToken })
    const byID = new Map(knowledge[guildID].videos.map(v => [v.video_id, v]))
    for (const v of videos) {
      byID.set(v.id, { video_id: v.id, title: v.title, description: v.description, published_at: v.publishedAt, live_status: v.liveStatus, scheduled_start: v.scheduledStart, duration: v.duration, url: v.url })
    }
    knowledge[guildID] = {
      channel: { ...knowledge[guildID].channel, channel_id: channel.id, title: channel.title, description: channel.description, handle: channel.handle, url: channel.url, backfill_token: backfillToken, synced_at: new Date('2026-10-29T12:00:00Z') },
      videos: [...byID.values()].sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    }
  }
  store.getSummary = async (guildID, videoID) => summaries[guildID]?.[videoID] || null
  store.saveSummary = async (guildID, videoID, summary) => {
    writes.push({ saveSummary: [guildID, videoID] })
    summaries[guildID] = { ...summaries[guildID], [videoID]: summary }
  }
  store.getOtherSummaries = async guildID => {
    const own = new Set((knowledge[guildID]?.videos || []).map(v => v.video_id))
    return Object.entries(summaries[guildID] || {}).filter(([id]) => !own.has(id)).map(([videoID, summary]) => ({ video_id: videoID, summary }))
  }
  store.deleteGuildYouTube = async guildID => {
    delete knowledge[guildID]
    delete summaries[guildID]
  }
  return { knowledge, summaries, writes, liveEvents }
}

function configureGateway () {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'
  process.env.CLOUDFLARE_AI_GATEWAY_ID = 'gw'
  process.env.GEMINI_API_KEY = 'gemini-key'
  delete process.env.CLOUDFLARE_AI_GATEWAY_TOKEN
  delete process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS
  delete process.env.GEMINI_MODEL
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
