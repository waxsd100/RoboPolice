// Stand-ins for the parts of Eris, Discord and Gemini the event drafting code touches. They record
// what the code did so tests can assert on it.
const http = require('http')

process.env.AES_KEY = process.env.AES_KEY || 'test-aes-key'
// The knowledge features have defaults for the real community (knowledgeDefaults.js); tests turn
// them off unless they set one.
for (const name of ['WIKI_URLS', 'TWITTER_ACCOUNTS', 'DISCORD_KNOWLEDGE_USERS', 'KNOWLEDGE_TOPICS', 'KNOWLEDGE_URLS', 'YOUTUBE_CHANNELS', 'TWITCH_CHANNELS', 'STEAM_ACCOUNTS']) process.env[name] ??= ''
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
  store.pendingMessages = async (limit, { after = null, before = null } = {}) => pending
    .filter(m => !saved.batched.has(m.id) && !saved.handled.includes(m.id) && (!after || (m.ts && m.ts >= after)) && (!before || !m.ts || m.ts < before))
    .slice(0, limit)
  // Embedding batches of past messages (Batch API).
  saved.batches = []
  saved.batched = new Set()
  store.saveEmbeddingBatch = async (name, model, ids) => {
    saved.batches.push({ name, model, message_ids: ids, created_at: new Date() })
    ids.forEach(id => saved.batched.add(id))
  }
  store.runningEmbeddingBatches = async () => saved.batches.map(b => ({ ...b }))
  store.noteEmbeddingBatch = async (name, { state = null, error = null } = {}) => {
    const batch = saved.batches.find(b => b.name === name)
    if (batch) Object.assign(batch, { state: state ?? batch.state, last_error: error, checked: (batch.checked || 0) + 1 })
  }
  store.deleteEmbeddingBatch = async name => {
    const batch = saved.batches.find(b => b.name === name)
    batch?.message_ids.forEach(id => saved.batched.delete(id))
    saved.batches = saved.batches.filter(b => b.name !== name)
  }
  store.saveMessageEmbeddings = async (rows, handled) => {
    saved.messages.push(...rows)
    saved.handled.push(...handled)
  }
  store.invalidateMessage = async id => saved.invalidated.push(id)
  // Embedded messages for cleansing: `messages` with an embedding, by ID.
  saved.dropped = []
  store.embeddedMessagesAfter = async (after, limit) => messages.filter(m => m.embedding && m.message_id > after)
    .sort((a, b) => (a.message_id < b.message_id ? -1 : 1)).slice(0, limit).map(m => ({ id: m.message_id, content: m.content }))
  store.dropMessageEmbeddings = async ids => {
    saved.dropped.push(...ids)
    return ids.length
  }
  store.nearestMessages = async (guildID, channelIDs, q, { limit = 60 } = {}) => messages
    .filter(m => m.guild_id === guildID && channelIDs.includes(m.channel_id))
    .map(m => ({ message_id: m.message_id, score: similarity(q, fromBase64(m.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  store.getMessages = async ids => messages.filter(m => ids.includes(m.message_id))
    .map(m => ({ id: m.message_id, author_id: m.author_id, channel_id: m.channel_id, ts: m.ts, content: m.content }))
  return saved
}

// Replaces the server knowledge store (serverLore.js) with an in-memory one, so no test reaches a
// real database. Installed when this file loads; a test can install it again with its own data.
// facts: { guildID: [{ kind, name, content, week, embedding }] }, styles: { guildID: text },
// messages: [{ guild_id, channel_id, author_id, ts, content }] (stored messages, newest last).
const realLoreStore = { ...require('../../src/db/interfaces/postgres/serverLore') }
// Puts the real store back, for the tests on a real database.
function restoreLoreStore () {
  Object.assign(require('../../src/db/interfaces/postgres/serverLore'), realLoreStore)
}
function installLoreStore ({ facts = {}, styles = {}, messages = [] } = {}) {
  const store = require('../../src/db/interfaces/postgres/serverLore')
  const { similarity, fromBase64 } = require('../../src/bot/utils/embeddings')
  const chunks = {}
  const saved = { chunks, styles: { ...styles } }
  store.channelMessages = async (guildID, channelID, since) => messages
    .filter(m => m.guild_id === guildID && m.channel_id === channelID && new Date(m.ts) >= since)
  store.chunkHashes = async guildID => Object.fromEntries(Object.entries(chunks[guildID] || {}).map(([k, c]) => [k, c.hash]))
  store.saveChunk = async (guildID, channelID, week, hash, list) => {
    chunks[guildID] = chunks[guildID] || {}
    chunks[guildID][`${channelID}|${week}`] = { hash, facts: list }
  }
  store.deleteChunksExcept = async (guildID, keys) => {
    let n = 0
    for (const k of Object.keys(chunks[guildID] || {})) if (!keys.includes(k)) { delete chunks[guildID][k]; n++ }
    return n
  }
  store.factsToEmbed = async () => []
  store.saveFactEmbedding = async () => {}
  store.nearestFacts = async (guildID, q, model, limit) => (facts[guildID] || [])
    .map(f => ({ ...f, score: f.embedding ? similarity(q, fromBase64(f.embedding)) : 0 }))
    .sort((a, b) => b.score - a.score).slice(0, limit)
  store.hasFacts = async guildID => (facts[guildID] || []).some(f => f.embedding)
  store.getStyle = async guildID => saved.styles[guildID] ? { style: saved.styles[guildID], source_hash: 'x', updated_at: new Date() } : null
  store.saveStyle = async (guildID, style) => { saved.styles[guildID] = style }
  store.deleteStyle = async guildID => { delete saved.styles[guildID] }
  store.memberMessages = async (guildID, authorID, channelIDs, limit) => messages
    .filter(m => m.guild_id === guildID && m.author_id === authorID && channelIDs.includes(m.channel_id))
    .reverse().slice(0, limit)
  return saved
}
installLoreStore()

// The reply settings (/replylength, /persona), in memory: lengths { guildID: 'long' | 'normal' |
// 'short' }, personas { guildID: false } for servers that turned the streamer off, debugFooters
// { guildID: true } for servers that show the debug line, tokenLimits { guildID: { '5h', week,
// flexAt } } for a server's own limits. Installed when this file loads, so no test reaches a real
// database.
function installReplyLengthStore (lengths = {}, personas = {}, debugFooters = {}, tokenLimits = {}, models = {}, rules = {}) {
  const store = require('../../src/db/interfaces/postgres/replySettings')
  store.getReplySettings = async guildID => ({
    replyLength: lengths[guildID] || null,
    streamerPersona: personas[guildID] !== false,
    debugFooter: debugFooters[guildID] === true,
    tokenLimits: { '5h': null, week: null, flexAt: null, unlimited: false, ...tokenLimits[guildID] },
    replyModel: models[guildID]?.model || null,
    replyThinking: models[guildID]?.thinking || null,
    assistantRules: rules[guildID] || null
  })
  store.setAssistantRules = async (guildID, text) => { rules[guildID] = text }
  store.setReplyModel = async (guildID, which, value) => { models[guildID] = { ...models[guildID], [which]: value } }
  store.setTokenLimit = async (guildID, which, value) => { tokenLimits[guildID] = { ...tokenLimits[guildID], [which]: value } }
  store.getReplyLength = async guildID => lengths[guildID] || null
  store.setReplyLength = async (guildID, length) => { lengths[guildID] = length }
  store.setStreamerPersona = async (guildID, enabled) => { personas[guildID] = enabled }
  store.setDebugFooter = async (guildID, enabled) => { debugFooters[guildID] = enabled }
  return { lengths, personas, debugFooters, tokenLimits, models, rules }
}
installReplyLengthStore()

// The Twitch store (twitchSync.js), in memory: channels [{ user_id, login, display_name }] and
// archives { userID: [video] }. Installed when this file loads (with nothing followed), so no test
// reaches a real database.
function installTwitchStore ({ channels = [], archives = {} } = {}) {
  const store = require('../../src/db/interfaces/postgres/twitch')
  store.setChannels = async list => {
    channels.splice(0, channels.length, ...list.map(c => ({ user_id: c.id, login: c.login, display_name: c.displayName, description: c.description, synced_at: null })))
    for (const id of Object.keys(archives)) if (!channels.some(c => c.user_id === id)) delete archives[id]
  }
  store.listChannels = async () => channels
  store.saveArchives = async (userID, videos, { complete = false } = {}) => {
    const known = archives[userID] || []
    const added = videos.filter(v => !known.some(k => k.video_id === v.id)).length
    const rows = videos.map(v => ({ video_id: v.id, user_id: userID, title: v.title, description: v.description, url: v.url, published_at: v.publishedAt, duration: v.duration }))
    archives[userID] = complete ? rows : [...rows, ...known.filter(k => !rows.some(r => r.video_id === k.video_id))]
    const channel = channels.find(c => c.user_id === userID)
    if (channel) channel.synced_at = new Date()
    return added
  }
  store.getArchives = async () => Object.entries(archives).flatMap(([id, list]) => {
    const c = channels.find(c => c.user_id === id) || {}
    return list.map(v => ({ ...v, login: c.login, display_name: c.display_name }))
  }).sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0))
  store.getOverview = async () => channels.map(c => ({ ...c, video_count: (archives[c.user_id] || []).length }))
  return { channels, archives }
}
installTwitchStore()

// The Steam store (steamSync.js), in memory: profiles, apps, games, reviews and wishlist.
// Installed when this file loads (with nothing followed), so no test reaches a real database.
function installSteamStore ({ profiles = [], apps = new Map(), games = {}, reviews = {}, wishlist = {} } = {}) {
  const store = require('../../src/db/interfaces/postgres/steam')
  store.setProfiles = async list => {
    profiles.splice(0, profiles.length, ...list.map(p => ({
      steam_id: p.steamId,
      account_ref: p.accountRef,
      persona_name: p.personaName || null,
      custom_url: p.customUrl || null,
      summary: p.summary || null,
      member_since: p.memberSince || null,
      level: p.level ?? null,
      game_count: p.gameCount ?? null,
      wishlist_count: p.wishlistCount ?? null,
      synced_at: null
    })))
    for (const id of Object.keys(games)) if (!profiles.some(p => p.steam_id === id)) delete games[id]
    for (const id of Object.keys(reviews)) if (!profiles.some(p => p.steam_id === id)) delete reviews[id]
    for (const id of Object.keys(wishlist)) if (!profiles.some(p => p.steam_id === id)) delete wishlist[id]
  }
  store.listProfiles = async () => profiles
  store.knownApps = async ids => {
    const out = new Map()
    for (const id of ids) if (apps.has(id)) out.set(id, apps.get(id))
    return out
  }
  store.saveApps = async list => {
    for (const a of list) apps.set(a.appId, { name: a.name, nameEn: a.nameEn || null })
  }
  store.saveAccountData = async (steamId, { profile = {}, games: gList = [], reviews: rList = null, wishlist: wList = null } = {}) => {
    const existingGames = games[steamId] || []
    const existingReviews = reviews[steamId] || []
    const newGames = gList.filter(g => !existingGames.some(e => e.app_id === g.appId)).length
    const newReviews = Array.isArray(rList) ? rList.filter(r => !existingReviews.some(e => e.app_id === r.appId)).length : 0

    const byApp = new Map(existingGames.map(g => [g.app_id, g]))
    for (const g of gList) {
      const prev = byApp.get(g.appId)
      const prevHours = prev && Number.isFinite(prev.playtime_hours) ? prev.playtime_hours : null
      const nextHours = Number.isFinite(g.playtimeHours) ? g.playtimeHours : null
      byApp.set(g.appId, {
        steam_id: steamId,
        app_id: g.appId,
        name: g.name,
        name_en: g.nameEn || prev?.name_en || null,
        playtime_hours: prevHours !== null && nextHours !== null ? Math.max(prevHours, nextHours) : (nextHours ?? prevHours),
        recent_hours: Number.isFinite(g.recentHours) ? g.recentHours : null,
        first_played_at: g.firstPlayedAt || prev?.first_played_at || null,
        last_played_at: g.lastPlayedAt || prev?.last_played_at || null
      })
    }
    games[steamId] = [...byApp.values()]

    if (Array.isArray(rList)) {
      reviews[steamId] = rList.map((r, position) => ({
        steam_id: steamId,
        app_id: r.appId,
        name: r.name || null,
        recommended: Boolean(r.recommended),
        hours_on_record: Number.isFinite(r.hoursOnRecord) ? r.hoursOnRecord : null,
        posted: r.posted || null,
        content: r.content,
        url: r.url,
        position
      }))
    }

    if (Array.isArray(wList)) {
      wishlist[steamId] = wList.map(w => ({
        steam_id: steamId,
        app_id: w.appId,
        name: w.name,
        name_en: w.nameEn || null,
        priority: w.priority ?? null,
        added_at: w.addedAt || null
      }))
    }

    const p = profiles.find(p => p.steam_id === steamId)
    if (p) {
      if (profile.personaName) p.persona_name = profile.personaName
      if (profile.customUrl) p.custom_url = profile.customUrl
      if (profile.summary) p.summary = profile.summary
      if (profile.memberSince) p.member_since = profile.memberSince
      if (Number.isInteger(profile.level)) p.level = profile.level
      if (Number.isInteger(profile.gameCount)) p.game_count = profile.gameCount
      if (Number.isInteger(profile.wishlistCount)) p.wishlist_count = profile.wishlistCount
      p.synced_at = new Date()
    }
    return { newGames, newReviews }
  }
  store.getOverview = async () => profiles.map(p => ({
    ...p,
    stored_game_count: (games[p.steam_id] || []).length,
    review_count: (reviews[p.steam_id] || []).length,
    stored_wishlist_count: (wishlist[p.steam_id] || []).length
  }))
  store.getGames = async () => Object.entries(games).flatMap(([id, list]) => {
    const p = profiles.find(p => p.steam_id === id) || {}
    return list.map(g => ({ ...g, account_ref: p.account_ref, persona_name: p.persona_name, custom_url: p.custom_url }))
  }).sort((a, b) => (b.playtime_hours ?? -1) - (a.playtime_hours ?? -1) || a.app_id - b.app_id)
  store.getReviews = async () => Object.entries(reviews).flatMap(([id, list]) => {
    const p = profiles.find(p => p.steam_id === id) || {}
    return list.map(r => ({ ...r, account_ref: p.account_ref, persona_name: p.persona_name, custom_url: p.custom_url }))
  }).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  store.getWishlist = async () => Object.entries(wishlist).flatMap(([id, list]) => {
    const p = profiles.find(p => p.steam_id === id) || {}
    return list.map(w => ({ ...w, account_ref: p.account_ref, persona_name: p.persona_name, custom_url: p.custom_url }))
  }).sort((a, b) => new Date(b.added_at || 0) - new Date(a.added_at || 0) || a.app_id - b.app_id)
  return { profiles, apps, games, reviews, wishlist }
}
installSteamStore()

// Rules channels are picked by their names in tests (serverRules.js), not by Gemini, so no test's
// scripted Gemini turns are taken by it.
{
  const serverRules = require('../../src/bot/modules/serverRules')
  serverRules.pick = async (guild, channels) => serverRules.byName(channels)
}

// The bot's load over the past hour (geminiLoad.js), in memory: counts { key: number }. Installed
// when this file loads, so no test reaches Redis.
function installLoadStore (counts = new Map()) {
  const load = require('../../src/bot/utils/geminiLoad')
  load.store.add = async (key, amount) => counts.set(key, (counts.get(key) || 0) + amount)
  load.store.get = async keys => keys.map(k => counts.get(k) || 0)
  load.reset()
  return counts
}
installLoadStore()

// Replaces the Redis counter behind the daily mention limit with an in-memory one.
// counts: { key: number } (the server caps and the token windows); windows also keep when each
// token window ends ({ key: Date }), by the `now` given (the clock otherwise).
function installQuotaStore () {
  const counts = new Map()
  const ends = new Map()
  const { store } = require('../../src/bot/utils/mentionQuota')
  const live = (key, now) => {
    const end = ends.get(key)
    if (end && end.getTime() <= now.getTime()) {
      counts.delete(key)
      ends.delete(key)
    }
  }
  store.get = async (key, now = new Date()) => {
    live(key, now)
    const end = ends.get(key)
    return { value: counts.get(key) || 0, resetsInMs: end ? end.getTime() - now.getTime() : null }
  }
  store.add = async (key, amount, seconds, now = new Date()) => {
    live(key, now)
    if (!ends.has(key)) ends.set(key, new Date(now.getTime() + seconds * 1000))
    counts.set(key, (counts.get(key) || 0) + amount)
  }
  store.increment = async key => {
    counts.set(key, (counts.get(key) || 0) + 1)
    return counts.get(key)
  }
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
  delete process.env.GEMINI_LIGHT_MODEL
  delete process.env.GEMINI_EXTRACT_MODEL
  delete process.env.GEMINI_THINKING_LEVEL
  delete process.env.VIDEO_SUMMARY_THINKING_LEVEL
  delete process.env.GEMINI_LIGHT_THINKING_LEVEL
  delete process.env.GEMINI_EXTRACT_THINKING_LEVEL
  // Tests script each Gemini call; the explicit cache is tested on its own (eventDrafter.test.js).
  process.env.GEMINI_EXPLICIT_CACHE = 'false'
  delete process.env.VIDEO_SUMMARY_FPS
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

// Tools whose results come back without the <untrusted> wrapper (untrusted.js), for tests about
// what a tool says rather than how it is marked.
function stripUntrusted (text) {
  return typeof text === 'string' ? text.replace(/^<untrusted source="[^"]*">\n/, '').replace(/\n<\/untrusted>$/, '') : text
}
function unwrapTools (tools) {
  const call = tools.call
  return Object.assign(tools, { call: async (...args) => { const res = await call(...args); return res.result === undefined ? res : { ...res, result: stripUntrusted(res.result) } } })
}

// Tool responses the model received in the last request.
function lastToolResponses (body) {
  const last = body.contents[body.contents.length - 1]
  // Without the <untrusted> wrapper around each result (untrusted.js).
  return last.parts.filter(p => p.functionResponse).map(p => p.functionResponse)
    .map(r => r.response?.result === undefined ? r : { ...r, response: { ...r.response, result: stripUntrusted(r.response.result) } })
}

async function startServer (handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

module.exports = {
  perms, createGuild, createMember, installBot, installYouTubeStore, installQuotaStore, installEmbeddingStore, configureGateway, installGemini, call, submit, lastToolResponses, startServer, installLoreStore, restoreLoreStore, stripUntrusted, unwrapTools, installLoadStore, installTwitchStore, installSteamStore
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
module.exports.installReplyLengthStore = installReplyLengthStore
