// Discord's game mentions: `<@$APPLICATION_ID>` shows a game's Discord profile (name, art, and a
// way to its official server), the way typing "@game Palworld" does in the app. The IDs come from
// Discord's public list of the games it knows (GET /applications/detectable, some 25,000), read
// once a day and kept in memory as name -> ID, its other names included.
const { normalize } = require('./gameLinks')
const aiCache = require('../utils/aiCache')

const DETECTABLE = 'https://discord.com/api/v10/applications/detectable'
const REFRESH_MS = 24 * 60 * 60 * 1000
const REFRESH_TTL_SECONDS = 24 * 60 * 60
const TIMEOUT_MS = 60 * 1000
const REDIS_INDEX_KEY = 'game-mentions:index'
const MAX_L1_GAMES = 64

let index = null
let loadedAt = 0
let loading = null
const l1Cache = new Map()

function rememberL1 (key, entry) {
  if (l1Cache.has(key)) l1Cache.delete(key)
  else if (l1Cache.size >= MAX_L1_GAMES) l1Cache.delete(l1Cache.keys().next().value)
  l1Cache.set(key, entry)
}

// name (normalized) -> { id, name }, from the list Discord gives.
function buildIndex (games) {
  const byName = new Map()
  for (const g of games) {
    if (!g?.id || !g.name) continue
    const entry = { id: String(g.id), name: g.name }
    for (const name of [g.name, ...(Array.isArray(g.aliases) ? g.aliases : [])]) {
      // An alias like "Palworld / パルワールド" names the game in several languages.
      for (const part of String(name).split(/\s+\/\s+/)) {
        const key = normalize(part)
        if (key && !byName.has(key)) byName.set(key, entry)
      }
    }
  }
  return byName
}

async function load ({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(DETECTABLE, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Discord's game list: HTTP ${res.status}`)
  const byName = buildIndex(await res.json())
  loadedAt = Date.now()
  l1Cache.clear()
  const storedInRedis = await aiCache.setJson(REDIS_INDEX_KEY, Object.fromEntries(byName), REFRESH_TTL_SECONDS)
  // When Redis holds the full index, avoid keeping ~60,000 entries in the Node.js heap.
  index = storedInRedis ? null : byName
  return byName
}

// The index, read again once a day. If reading fails, the old one is kept (or none).
async function games (options) {
  if (index && Date.now() - loadedAt < REFRESH_MS) return index
  const cached = await aiCache.getJson(REDIS_INDEX_KEY)
  if (cached && typeof cached === 'object') {
    if (!loadedAt) loadedAt = Date.now()
    return new Map(Object.entries(cached))
  }
  if (!loading) {
    loading = load(options).catch(e => {
      global.logger.warn(`[GAMES]: ${e.message}`)
      return index
    }).finally(() => { loading = null })
  }
  return loading
}

// { id, name, mention } of the first of `names` Discord knows, or null.
async function findGame (names, options) {
  const cleaned = names.filter(Boolean)
  if (!cleaned.length) return null
  if (loadedAt && Date.now() - loadedAt < REFRESH_MS) {
    for (const name of cleaned) {
      const hit = l1Cache.get(normalize(name))
      if (hit) return { ...hit, mention: `<@$${hit.id}>` }
    }
  }
  const byName = await games(options)
  if (!byName) return null
  for (const name of cleaned) {
    const key = normalize(name)
    const hit = byName.get(key)
    if (hit) {
      rememberL1(key, hit)
      return { ...hit, mention: `<@$${hit.id}>` }
    }
  }
  return null
}

function reset () {
  index = null
  loadedAt = 0
  l1Cache.clear()
  aiCache.del(REDIS_INDEX_KEY)
}

module.exports = { findGame, buildIndex, games, reset }
