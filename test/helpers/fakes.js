// Stand-ins for the parts of Eris, Discord and Gemini the event drafting code touches. They record
// what the code did so tests can assert on it.
const http = require('http')

process.env.AES_KEY = process.env.AES_KEY || 'test-aes-key'
// The knowledge features have defaults for the real community (knowledgeDefaults.js); tests turn
// them off unless they set one.
for (const name of ['WIKI_URLS', 'TWITTER_ACCOUNTS', 'DISCORD_KNOWLEDGE_USERS', 'KNOWLEDGE_TOPICS', 'KNOWLEDGE_URLS', 'YOUTUBE_CHANNELS', 'YOUTUBE_API_KEY', 'TWITCH_CHANNELS', 'STEAM_ACCOUNTS']) process.env[name] ??= ''
global.logger = global.logger || { info () {}, warn () {}, error () {}, debug () {}, startup () {}, fatal () {} }
global.webhook = global.webhook || { generic () {}, warn () {}, error () {}, fatal () {} }

const READ = ['viewChannel', 'readMessageHistory']

function perms (names) {
  return { has: name => names.includes(name), json: Object.fromEntries(names.map(n => [n, true])) }
}

// channels: [{ id, name, type, readers: [userID], posters: [userID], moderators: [userID], externalEmojis: boolean }]
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
        ...((c.moderators || []).includes(userID) ? ['manageThreads'] : []),
        ...(c.externalEmojis !== false ? ['externalEmojis'] : [])
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
    guilds: new Map(guilds.map(g => [g.id, g])),
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
        if (method === 'POST' && url.endsWith('/messages')) return { id: 'MSG1', ...body }
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
  store.pendingMessages = async (limit, { after = null, before = null } = {}) => {
    const { isEmbedMessagesEnabled } = require('../../src/db/interfaces/postgres/replySettings')
    const out = []
    for (const m of pending) {
      if (saved.batched.has(m.id) || saved.handled.includes(m.id)) continue
      if (after && (!m.ts || m.ts < after)) continue
      if (before && m.ts && m.ts >= before) continue
      if (m.guild_id && !(await isEmbedMessagesEnabled(m.guild_id))) continue
      out.push(m)
      if (out.length >= limit) break
    }
    return out
  }
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
  store.keywordMessages = async (guildID, channelIDs, words, { limit = 60 } = {}) => words.length
    ? messages
      .filter(m => m.guild_id === guildID && channelIDs.includes(m.channel_id) && words.every(w => String(m.content).toLowerCase().includes(w)))
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, limit)
      .map(m => ({ message_id: m.message_id }))
    : []
  store.messageVectors = async ids => new Map(messages.filter(m => ids.includes(m.message_id) && m.embedding).map(m => [m.message_id, fromBase64(m.embedding)]))
  // `reply_to` on a message: the one it replied to.
  store.replyLinks = async ids => messages
    .filter(m => m.reply_to && (ids.includes(m.message_id) || ids.includes(m.reply_to)))
    .map(m => ({ message_id: m.message_id, reply_to: m.reply_to }))
  store.messagesAround = async (channelID, ts, { before = 1, after = 2, withinSeconds = 30 * 60 } = {}) => {
    const at = new Date(ts).getTime()
    const inChannel = messages.filter(m => m.channel_id === channelID && Math.abs(new Date(m.ts).getTime() - at) <= withinSeconds * 1000)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts))
      .map(m => ({ id: m.message_id, author_id: m.author_id, channel_id: m.channel_id, ts: m.ts, content: m.content }))
    const earlier = inChannel.filter(m => new Date(m.ts).getTime() < at).slice(-before)
    const later = inChannel.filter(m => new Date(m.ts).getTime() > at).slice(0, after)
    return [...earlier, ...later]
  }
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
  saved.styleHashes = {}
  store.getStyle = async guildID => saved.styles[guildID] ? { style: saved.styles[guildID], source_hash: saved.styleHashes[guildID] || 'x', updated_at: new Date() } : null
  store.saveStyle = async (guildID, style, hash) => {
    saved.styles[guildID] = style
    saved.styleHashes[guildID] = hash
  }
  store.deleteStyle = async guildID => { delete saved.styles[guildID] }
  store.memberMessages = async (guildID, authorID, channelIDs, limit) => messages
    .filter(m => m.guild_id === guildID && m.author_id === authorID && channelIDs.includes(m.channel_id))
    .reverse().slice(0, limit)
  return saved
}
installLoreStore()

// Replaces the server emoji store (emojis.js) with an in-memory one, so no test reaches a real
// database unless restoreEmojiStore() is called (stores.test.js).
const realEmojiStore = { ...require('../../src/db/interfaces/postgres/emojis') }
function restoreEmojiStore () {
  Object.assign(require('../../src/db/interfaces/postgres/emojis'), realEmojiStore)
}
function installEmojiStore ({ emojis = {}, descriptions = {} } = {}) {
  const store = require('../../src/db/interfaces/postgres/emojis')
  const { similarity, fromBase64 } = require('../../src/bot/utils/embeddings')
  const guildList = g => (Array.isArray(g) ? g : [g]).filter(Boolean)
  store.listEmojis = async guildID => guildList(guildID).flatMap(id => (emojis[id] || []).map(e => ({
    id: e.id,
    guild_id: id,
    name: e.name,
    animated: !!e.animated
  })))
  store.descriptions = async guildID => {
    const allowed = new Set(guildList(guildID).flatMap(id => (emojis[id] || []).map(e => e.id)))
    const out = {}
    for (const [id, desc] of Object.entries(descriptions)) {
      if ((!allowed.size || allowed.has(id)) && desc) out[id] = desc
    }
    return out
  }
  store.nearestEmojis = async (guildID, q, _model, limit) => guildList(guildID)
    .flatMap(id => emojis[id] || [])
    .filter(e => e.embedding)
    .map(e => ({ id: e.id, score: similarity(q, fromBase64(e.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(e => e.id)
  store.syncEmojis = async () => {}
  store.emojisToDescribe = async () => []
  store.emojisToEmbed = async () => []
  store.saveDescription = async () => {}
  store.saveEmbedding = async () => {}
  return { emojis, descriptions }
}
installEmojiStore()

// Replaces the streamer speaking-style store (streamerStyle.js) with an in-memory one so no unit
// test reaches Postgres unless restoreStreamerStyleStore() is called (stores.test.js).
const realStreamerStyleStore = { ...require('../../src/db/interfaces/postgres/streamerStyle') }
function restoreStreamerStyleStore () {
  Object.assign(require('../../src/db/interfaces/postgres/streamerStyle'), realStreamerStyleStore)
}
function installStreamerStyleStore (entries = {}) {
  const store = require('../../src/db/interfaces/postgres/streamerStyle')
  const saved = { ...entries }
  store.getStyle = async (key = store.DEFAULT_KEY) => saved[key] ? { ...saved[key] } : null
  store.saveStyle = async (entry, key = store.DEFAULT_KEY) => {
    saved[key] = {
      profile: String(entry?.profile || ''),
      quantitative: String(entry?.quantitative || ''),
      exemplars: Array.isArray(entry?.exemplars) ? [...entry.exemplars] : [],
      dialoguePairs: Array.isArray(entry?.dialoguePairs) ? entry.dialoguePairs.map(p => ({ ...p })) : [],
      sourceHash: String(entry?.sourceHash || ''),
      updatedAt: entry?.updatedAt || Date.now()
    }
  }
  store.deleteStyle = async (key = store.DEFAULT_KEY) => { delete saved[key] }
  return saved
}
installStreamerStyleStore()

// The reply settings (/replylength, /persona), in memory: lengths { guildID: 'long' | 'normal' |
// 'short' }, personas { guildID: false } for servers that turned the streamer off, debugFooters
// { guildID: true } for servers that show the debug line, tokenLimits { guildID: { '5h', week,
// flexAt } } for a server's own limits. Installed when this file loads, so no test reaches a real
// database.
function installReplyLengthStore (lengths = {}, personas = {}, debugFooters = {}, tokenLimits = {}, models = {}, aiModels = {}, embeddings = {}, safety = {}) {
  const store = require('../../src/db/interfaces/postgres/replySettings')
  const { isOwnerGuild } = require('../../src/bot/utils/priority')
  const taskModelsOf = guildID => {
    const out = { ...(aiModels[guildID] || {}) }
    if (models[guildID]?.model || models[guildID]?.thinking || models[guildID]?.tier) {
      out.reply = { model: null, thinking: null, tier: null, ...out.reply, ...models[guildID] }
    }
    return out
  }
  store.getReplySettings = async guildID => {
    const tasks = taskModelsOf(guildID)
    const owner = isOwnerGuild(guildID)
    const emb = { messages: null, emojis: null, ...embeddings[guildID] }
    const saf = { filter: null, uncensored: null, ...safety[guildID] }
    return {
      replyLength: lengths[guildID] || null,
      streamerPersona: personas[guildID] !== false,
      debugFooter: debugFooters[guildID] === true,
      tokenLimits: { '5h': null, week: null, flexAt: null, unlimited: false, ...tokenLimits[guildID] },
      replyModel: tasks.reply?.model || null,
      replyThinking: tasks.reply?.thinking || null,
      aiModels: tasks,
      embeddings: emb,
      embedMessages: emb.messages ?? owner,
      embedEmojis: emb.emojis ?? owner,
      safety: saf,
      safetyFilter: saf.filter ?? !owner,
      uncensoredR18: saf.uncensored ?? owner
    }
  }
  store.isEmbedMessagesEnabled = async guildID => {
    if (!guildID) return false
    return embeddings[guildID]?.messages ?? isOwnerGuild(guildID)
  }
  store.isEmbedEmojisEnabled = async guildID => {
    if (!guildID) return false
    return embeddings[guildID]?.emojis ?? isOwnerGuild(guildID)
  }
  store.setEmbedding = async (guildID, which, value) => {
    if (which === 'all') {
      embeddings[guildID] = { messages: value, emojis: value }
      return
    }
    embeddings[guildID] = { messages: null, emojis: null, ...embeddings[guildID], [which]: value }
  }
  store.setSafety = async (guildID, which, value) => {
    if (which === 'all') {
      safety[guildID] = {
        filter: value === null ? null : Boolean(value),
        uncensored: value === null ? null : !value
      }
      return
    }
    safety[guildID] = { filter: null, uncensored: null, ...safety[guildID], [which]: value }
  }
  store.getTaskModel = async (guildID, task) => {
    if (guildID) return taskModelsOf(guildID)[task] || null
    for (const g of Object.keys(aiModels).sort()) {
      if (aiModels[g]?.[task]) return aiModels[g][task]
    }
    return null
  }
  store.setTaskModel = async (guildID, task, which, value) => {
    if (!aiModels[guildID]) aiModels[guildID] = {}
    if (which === 'all') {
      delete aiModels[guildID][task]
      if (task === 'reply') models[guildID] = { model: null, thinking: null }
      return
    }
    aiModels[guildID][task] = { model: null, thinking: null, tier: null, ...aiModels[guildID][task], [which]: value }
    if (!aiModels[guildID][task].model && !aiModels[guildID][task].thinking && !aiModels[guildID][task].tier) delete aiModels[guildID][task]
    if (task === 'reply') models[guildID] = { ...models[guildID], [which]: value }
  }
  store.setReplyModel = async (guildID, which, value) => store.setTaskModel(guildID, 'reply', which, value)
  store.setTokenLimit = async (guildID, which, value) => { tokenLimits[guildID] = { ...tokenLimits[guildID], [which]: value } }
  store.getReplyLength = async guildID => lengths[guildID] || null
  store.setReplyLength = async (guildID, length) => { lengths[guildID] = length }
  store.setStreamerPersona = async (guildID, enabled) => { personas[guildID] = enabled }
  store.setDebugFooter = async (guildID, enabled) => { debugFooters[guildID] = enabled }
  return { lengths, personas, debugFooters, tokenLimits, models, aiModels, embeddings, safety }
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
    const rows = videos.map(v => ({
      video_id: v.id,
      user_id: userID,
      title: v.title,
      description: v.description,
      url: v.url,
      published_at: v.publishedAt,
      duration: v.duration,
      view_count: Number.isInteger(v.viewCount) ? v.viewCount : (Number.isInteger(v.view_count) ? v.view_count : null)
    }))
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

// Shared Redis cache for AI artifacts (aiCache.js), in memory: entries { key: string }. Installed
// when this file loads, so no test reaches Redis.
function installAiCacheStore (entries = new Map()) {
  const aiCache = require('../../src/bot/utils/aiCache')
  aiCache.store.get = async key => entries.has(key) ? entries.get(key) : null
  aiCache.store.mget = async keys => keys.map(k => entries.has(k) ? entries.get(k) : null)
  aiCache.store.set = async (key, value) => { entries.set(key, String(value)) }
  aiCache.store.mset = async pairs => { for (const [k, v] of pairs) entries.set(k, String(v)) }
  aiCache.store.setnx = async (key, value) => {
    if (entries.has(key)) return false
    entries.set(key, String(value))
    return true
  }
  aiCache.store.del = async key => { entries.delete(key) }
  return entries
}
installAiCacheStore()

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
  store.getVideo = async videoID => {
    const found = allVideos().find(v => v.video_id === videoID)
    if (!found) return null
    const ch = channels().find(c => c.channel_id === found.channel_id)
    return { ...found, channel_title: ch?.title || null, summary: anySummary(videoID) || found.summary || null }
  }
  store.videosForKnowledge = async ({ unsummarizedLimit = 25 } = {}) => {
    const chMap = new Map(channels().map(c => [c.channel_id, c.title || null]))
    const finished = allVideos()
      .filter(v => !['live', 'upcoming'].includes(v.live_status))
      .map(v => ({
        video_id: v.video_id,
        channel_id: v.channel_id,
        channel_title: chMap.get(v.channel_id) || null,
        title: v.title,
        published_at: v.published_at,
        duration: v.duration ?? null,
        summary: anySummary(v.video_id) || v.summary || null
      }))
    const summarized = finished.filter(v => v.summary !== null)
    const unsummarized = unsummarizedLimit > 0 ? finished.filter(v => v.summary === null).slice(0, unsummarizedLimit) : []
    return [...summarized, ...unsummarized]
  }
  store.getVideoIds = async (channelID = null) => new Set(allVideos().filter(v => !channelID || v.channel_id === channelID).map(v => v.video_id))
  store.videoIdsMissingStats = async (channelID, limit = 200) => allVideos()
    .filter(v => v.channel_id === channelID && v.stats_updated_at === null)
    .slice(0, limit)
    .map(v => v.video_id)
  store.markStatsChecked = async videoIDs => {
    if (!videoIDs?.length) return
    writes.push({ markStatsChecked: videoIDs })
    const idSet = new Set(videoIDs)
    for (const g of Object.keys(knowledge)) {
      for (const v of (knowledge[g].videos || [])) {
        if (idSet.has(v.video_id) && !v.stats_updated_at) v.stats_updated_at = new Date('2026-10-29T12:00:00Z')
      }
    }
  }
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
      for (const v of videos) {
        const prev = byID.get(v.id) || {}
        const hasStats = v.viewCount != null || v.likeCount != null || v.commentCount != null
        byID.set(v.id, {
          ...prev,
          video_id: v.id,
          title: v.title,
          description: v.description ?? prev.description,
          live_status: v.liveStatus,
          scheduled_start: v.scheduledStart,
          actual_start: v.actualStart ?? prev.actual_start ?? null,
          actual_end: v.actualEnd ?? prev.actual_end ?? null,
          published_at: v.publishedAt,
          duration: v.duration ?? prev.duration ?? null,
          view_count: v.viewCount ?? prev.view_count ?? null,
          like_count: v.likeCount ?? prev.like_count ?? null,
          comment_count: v.commentCount ?? prev.comment_count ?? null,
          stats_updated_at: hasStats ? new Date('2026-10-29T12:00:00Z') : prev.stats_updated_at,
          url: v.url
        })
      }
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
        const prev = byID.get(v.id) || {}
        const hasStats = v.viewCount != null || v.likeCount != null || v.commentCount != null
        byID.set(v.id, {
          ...prev,
          video_id: v.id,
          title: v.title,
          description: v.description,
          published_at: v.publishedAt,
          live_status: v.liveStatus,
          scheduled_start: v.scheduledStart,
          actual_start: v.actualStart ?? prev.actual_start ?? null,
          actual_end: v.actualEnd ?? prev.actual_end ?? null,
          duration: v.duration,
          view_count: v.viewCount ?? prev.view_count ?? null,
          like_count: v.likeCount ?? prev.like_count ?? null,
          comment_count: v.commentCount ?? prev.comment_count ?? null,
          stats_updated_at: hasStats ? new Date('2026-10-29T12:00:00Z') : prev.stats_updated_at,
          url: v.url
        })
      }
      Object.assign(k.channel, {
        channel_id: channel.id,
        title: channel.title,
        description: channel.description,
        handle: channel.handle,
        subscriber_count: channel.subscriberCount ?? k.channel.subscriber_count ?? null,
        view_count: channel.viewCount ?? k.channel.view_count ?? null,
        url: channel.url,
        backfill_token: backfillToken,
        synced_at: new Date('2026-10-29T12:00:00Z')
      })
      k.videos = [...byID.values()].sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    }
  }
  // Summaries are shared: one made for any server is found for all.
  store.getSummary = async videoID => anySummary(videoID)
  store.videoCards = async ids => Object.values(knowledge).flatMap(k => (k.videos || []).map(v => ({ video_id: v.video_id, title: v.title, channel_title: k.channel?.title || null })))
    .filter(v => ids.includes(v.video_id))
  store.getVideo = async videoID => {
    for (const k of Object.values(knowledge)) {
      const hit = (k.videos || []).find(v => v.video_id === videoID)
      if (hit) return { ...hit, channel_id: k.channel?.channel_id || null, channel_title: k.channel?.title || null, summary: anySummary(videoID) }
    }
    return null
  }
  store.videosInSummaryBatch = async videoIDs => {
    const wanted = new Set(videoIDs || [])
    return new Set(allVideos().filter(v => wanted.has(v.video_id) && v.summary_batch).map(v => v.video_id))
  }
  store.videoDuration = async videoID => allVideos().find(v => v.video_id === videoID)?.duration || null
  store.saveSummary = async (guildID, videoID, summary = null) => {
    writes.push({ saveSummary: [guildID, videoID] })
    summaries[guildID] = { ...summaries[guildID], [videoID]: summary ?? await store.getSummary(videoID) }
  }
  store.getOtherSummaries = async () => {
    const own = new Set(allVideos().map(v => v.video_id))
    const ids = [...new Set(Object.values(summaries).flatMap(s => Object.keys(s)))].filter(id => !own.has(id))
    return ids.map(id => ({ video_id: id, summary: anySummary(id) })).filter(r => r.summary)
  }
  store.recentVideosForStyle = async (limit = 20) => allVideos()
    .filter(v => !['live', 'upcoming'].includes(v.live_status))
    .slice(0, limit)
    .map(v => ({ ...v, summary: anySummary(v.video_id) || v.summary || null }))
  store.deleteGuildYouTube = async guildID => {
    delete liveSettings[guildID]
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
  // Tests script each Gemini call; the explicit cache and Decisions API are tested on their own.
  process.env.GEMINI_EXPLICIT_CACHE = 'false'
  process.env.GEMINI_DECISION_API = 'false'
  delete process.env.VIDEO_SUMMARY_FPS
  delete process.env.GEMINI_DECISION_TIMEOUT_MS
  delete process.env.GEMINI_DECISION_BOOL_THRESHOLD
  installAiCacheStore()
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
  perms, createGuild, createMember, installBot, installYouTubeStore, installQuotaStore, installEmbeddingStore, configureGateway, installGemini, call, submit, lastToolResponses, startServer, installLoreStore, restoreLoreStore, installEmojiStore, restoreEmojiStore, installStreamerStyleStore, restoreStreamerStyleStore, stripUntrusted, unwrapTools, installLoadStore, installAiCacheStore, installTwitchStore, installSteamStore
}

// A fake embedding model: each text points along the axis of the first topic it mentions, so
// texts about the same topic are close whatever their wording. Records every batch.
const TOPICS = [['ホラー', '怖い', 'こわい'], ['マイクラ', 'minecraft', '建築'], ['歌', 'カラオケ', 'singing']]
function installEmbeddingModel () {
  const batches = []
  // A new model for the test: no query embedded by an earlier one is reused.
  require('../../src/bot/utils/embeddings').embedQuery.clearCache()
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

// The mention log store (mentionLogs.js), in memory: logs [{ id, guild_id, ... }]. Each row also
// keeps `statuses`, every status it was given in order.
function installMentionLogStore (logs = []) {
  const store = require('../../src/db/interfaces/postgres/mentionLogs')
  const COLUMNS = {
    status: 'status',
    kind: 'kind',
    request: 'request',
    prompt: 'prompt',
    response: 'response',
    replyMessageID: 'reply_message_id',
    followUpMessageIDs: 'follow_up_message_ids',
    model: 'model',
    promptTokens: 'prompt_tokens',
    cachedTokens: 'cached_tokens',
    outputTokens: 'output_tokens',
    thinkingTokens: 'thinking_tokens',
    geminiCalls: 'gemini_calls',
    blockReason: 'block_reason',
    fallbacks: 'fallbacks',
    context: 'context',
    aiTranscript: 'ai_transcript'
  }
  store.startMentionLog = async entry => {
    const row = {
      id: String(logs.length + 1),
      guild_id: entry.guildID,
      channel_id: entry.channelID,
      message_id: entry.messageID,
      reply_message_id: null,
      follow_up_message_ids: null,
      user_id: entry.userID,
      user_name: entry.userName ?? null,
      status: 'received',
      statuses: ['received'],
      kind: null,
      request: entry.request ?? '',
      prompt: null,
      response: null,
      model: null,
      prompt_tokens: 0,
      cached_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      gemini_calls: 0,
      block_reason: null,
      fallbacks: null,
      context: null,
      ai_transcript: null,
      replied_to_message_id: entry.repliedToMessageID ?? null,
      created_at: new Date(),
      finished_at: null
    }
    logs.push(row)
    return row.id
  }
  store.updateMentionLog = async (id, fields = {}) => {
    const row = logs.find(r => r.id === id)
    for (const [key, column] of Object.entries(COLUMNS)) {
      if (fields[key] !== undefined) row[column] = fields[key]
    }
    // As v_mention_logs shows them: the fallbacks joined, and the further messages as a list.
    if (Array.isArray(fields.fallbacks)) row.fallbacks = fields.fallbacks.join('; ')
    if (fields.status) row.statuses.push(fields.status)
    if (['done', 'failed'].includes(fields.status)) row.finished_at = new Date()
  }
  store.saveMentionLog = async ({ kind, response, ...entry }) => {
    const id = await store.startMentionLog(entry)
    await store.updateMentionLog(id, { ...entry, status: kind === 'error' ? 'failed' : 'done', kind, response: response ?? null })
    return id
  }
  store.getMentionLogs = async (guildID, { limit = 50, userID = null } = {}) => logs
    .filter(r => r.guild_id === guildID && (!userID || r.user_id === userID))
    .slice()
    .reverse()
    .slice(0, limit)
  store.findPostCreator = async (guildID, path, kind = 'forum') => {
    if (!guildID || !path) return null
    const needle = `/channels/${guildID}/${path}`
    const hit = logs.find(r => r.guild_id === guildID && r.kind === kind && String(r.response || '').includes(needle))
    return hit?.user_id || null
  }
  return logs
}
installMentionLogStore()

const realAltDetectionStore = { ...require('../../src/db/interfaces/postgres/altDetection') }
function restoreAltDetectionStore () {
  Object.assign(require('../../src/db/interfaces/postgres/altDetection'), realAltDetectionStore)
}
function installAltDetectionStore ({ enabled = {}, profiles = [], messages = [], snapshots = [], centroids = {}, alerts = [] } = {}) {
  const store = require('../../src/db/interfaces/postgres/altDetection')
  const state = {
    enabled: { ...enabled },
    profiles: new Map(profiles.map(p => [`${p.guildID}:${p.userID}`, { ...p }])),
    messages: messages.map(m => ({ ...m })),
    snapshots: snapshots.map(s => ({ ...s })),
    centroids: { ...centroids },
    alerts: alerts.map(a => ({ ...a }))
  }
  store.resetCache = () => {}
  store.isAltDetectionEnabled = async guildID => Boolean(state.enabled[guildID])
  store.setAltDetection = async (guildID, val) => {
    state.enabled[guildID] = Boolean(val)
    return state.enabled[guildID]
  }
  store.upsertMemberProfile = async (guildID, profile) => {
    if (!guildID || !profile?.userID) return
    const key = `${guildID}:${profile.userID}`
    const prev = state.profiles.get(key) || {}
    state.profiles.set(key, {
      ...prev,
      guildID,
      userID: profile.userID,
      username: profile.username ?? prev.username ?? null,
      globalName: profile.globalName ?? prev.globalName ?? null,
      nick: profile.nick ?? prev.nick ?? null,
      avatarHash: profile.avatarHash ?? prev.avatarHash ?? null,
      avatarURL: profile.avatarURL ?? prev.avatarURL ?? null,
      accountCreatedAt: profile.accountCreatedAt ? new Date(profile.accountCreatedAt) : (prev.accountCreatedAt || null),
      joinedAt: profile.joinedAt ? new Date(profile.joinedAt) : (prev.joinedAt || null),
      inviteCode: profile.inviteCode ?? prev.inviteCode ?? null,
      status: profile.status || prev.status || 'active',
      statusAt: profile.statusAt ? new Date(profile.statusAt) : (prev.statusAt || null),
      moderationReason: profile.moderationReason ?? prev.moderationReason ?? null,
      updatedAt: new Date()
    })
  }
  store.markMemberStatus = async (guildID, userID, status, { reason = null, at = new Date(), profile = {} } = {}) => {
    return store.upsertMemberProfile(guildID, { ...profile, userID, status, statusAt: at, moderationReason: reason })
  }
  store.getMemberProfile = async (guildID, userID) => state.profiles.get(`${guildID}:${userID}`) || null
  store.getCandidateProfiles = async (guildID, excludeUserID, { limit = 200 } = {}) => {
    const rank = s => (s === 'banned' ? 0 : s === 'kicked' ? 1 : s === 'restricted' ? 2 : s === 'left' ? 3 : 4)
    return [...state.profiles.values()]
      .filter(p => p.guildID === guildID && p.userID !== excludeUserID)
      .sort((a, b) => rank(a.status) - rank(b.status))
      .slice(0, limit)
  }
  store.recordMessageSnapshot = async (guildID, {
    messageID,
    authorID,
    channelID = null,
    eventType = 'deleted',
    deletedBy = 'unknown',
    moderatorID = null,
    content,
    originalTs = null,
    eventTs = new Date()
  }) => {
    const clean = String(content || '').trim()
    if (!guildID || !messageID || !authorID || !clean) return false
    if (eventType === 'deleted' && state.snapshots.some(s => s.guildID === guildID && s.messageID === messageID && s.eventType === 'deleted')) {
      return false
    }
    state.snapshots.push({
      guildID,
      messageID,
      authorID,
      channelID,
      eventType: eventType === 'edited' ? 'edited' : 'deleted',
      deletedBy: eventType === 'edited' ? 'unknown' : (deletedBy || 'unknown'),
      moderatorID: moderatorID || null,
      content: clean,
      originalTs: originalTs ? new Date(originalTs) : null,
      eventTs: eventTs ? new Date(eventTs) : new Date()
    })
    return true
  }
  store.updateSnapshotDeletionActor = async (guildID, messageID, { deletedBy = 'unknown', moderatorID = null } = {}) => {
    let updated = false
    for (const s of state.snapshots) {
      if (s.guildID === guildID && s.messageID === messageID && s.eventType === 'deleted') {
        s.deletedBy = deletedBy || 'unknown'
        if (moderatorID) s.moderatorID = moderatorID
        updated = true
      }
    }
    return updated
  }
  store.snapshotMessagesBeforeDelete = async (messageIDs, { deletedBy = 'unknown', moderatorID = null, eventTs = new Date() } = {}) => {
    const ids = new Set((messageIDs || []).filter(Boolean))
    const captured = []
    for (const m of state.messages) {
      if (!ids.has(m.id) || !m.guildID || !m.content) continue
      const added = await store.recordMessageSnapshot(m.guildID, {
        messageID: m.id,
        authorID: m.authorID,
        channelID: m.channelID,
        eventType: 'deleted',
        deletedBy,
        moderatorID,
        content: m.content,
        originalTs: m.ts,
        eventTs
      })
      if (added) {
        captured.push({
          guildID: m.guildID,
          id: m.id,
          authorID: m.authorID,
          channelID: m.channelID,
          content: m.content,
          ts: m.ts ? new Date(m.ts) : new Date(eventTs),
          eventTs: new Date(eventTs),
          deleted: true,
          deletedBy: deletedBy || 'unknown',
          moderatorID: moderatorID || null,
          editedBefore: false
        })
      }
    }
    return captured
  }
  const combinedForGuild = (guildID, includeDeleted) => {
    const live = state.messages
      .filter(m => m.guildID === guildID && m.content)
      .map(m => ({ ...m, deleted: Boolean(m.deleted), deletedBy: m.deletedBy || null, moderatorID: m.moderatorID || null, editedBefore: Boolean(m.editedBefore), eventTs: m.eventTs || null }))
    if (!includeDeleted) return live
    const snaps = state.snapshots
      .filter(s => s.guildID === guildID && s.content)
      .map(s => ({
        id: `${s.messageID}:${s.eventType}`,
        messageID: s.messageID,
        guildID: s.guildID,
        authorID: s.authorID,
        channelID: s.channelID,
        content: s.content,
        ts: s.originalTs ? new Date(s.originalTs) : new Date(s.eventTs),
        deleted: s.eventType === 'deleted',
        deletedBy: s.eventType === 'deleted' ? (s.deletedBy || 'unknown') : null,
        moderatorID: s.moderatorID || null,
        editedBefore: s.eventType === 'edited',
        eventTs: s.eventTs ? new Date(s.eventTs) : null
      }))
    return [...live, ...snaps]
  }
  store.getMemberMessages = async (guildID, userID, { limit = 60, includeDeleted = true } = {}) => combinedForGuild(guildID, includeDeleted)
    .filter(m => m.authorID === userID)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, limit)
  store.getRecentAuthorsMessages = async (guildID, excludeUserID, { authorLimit = 30, perAuthor = 30, days = 30, includeDeleted = true } = {}) => {
    const since = Date.now() - days * 86400 * 1000
    const byAuthor = new Map()
    for (const m of combinedForGuild(guildID, includeDeleted)) {
      if (m.authorID === excludeUserID || !m.content) continue
      const refTime = m.eventTs ? new Date(m.eventTs).getTime() : new Date(m.ts).getTime()
      if (refTime < since) continue
      if (!byAuthor.has(m.authorID)) byAuthor.set(m.authorID, [])
      byAuthor.get(m.authorID).push(m)
    }
    const grouped = new Map()
    for (const [authorID, list] of byAuthor) {
      if (list.length < 3 && !list.some(m => m.deleted)) continue
      grouped.set(authorID, list.sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, perAuthor))
      if (grouped.size >= authorLimit) break
    }
    return grouped
  }
  store.getAuthorEmbeddingCentroid = async (guildID, userID) => state.centroids[`${guildID}:${userID}`] || null
  store.hasRecentAlert = async (guildID, suspectUserID, candidateUserID, cooldownHours = 24) => {
    const since = Date.now() - cooldownHours * 3600 * 1000
    return state.alerts.some(a =>
      a.guildID === guildID &&
      a.suspectUserID === suspectUserID &&
      a.candidateUserID === candidateUserID &&
      new Date(a.createdAt).getTime() >= since
    )
  }
  store.recordAlert = async (guildID, entry) => {
    const row = {
      id: state.alerts.length + 1,
      guildID,
      ...entry,
      createdAt: new Date()
    }
    state.alerts.push(row)
    return { id: row.id, created_at: row.createdAt }
  }
  store.getRecentAlerts = async (guildID, { limit = 10 } = {}) => state.alerts
    .filter(a => a.guildID === guildID)
    .slice()
    .reverse()
    .slice(0, limit)
  return state
}
installAltDetectionStore()

module.exports.installEmbeddingModel = installEmbeddingModel
module.exports.installReplyLengthStore = installReplyLengthStore
module.exports.installMentionLogStore = installMentionLogStore
module.exports.installAltDetectionStore = installAltDetectionStore
module.exports.restoreAltDetectionStore = restoreAltDetectionStore
