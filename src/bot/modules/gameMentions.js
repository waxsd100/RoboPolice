// Discord's game mentions: `<@$APPLICATION_ID>` shows a game's Discord profile (name, art, and a
// way to its official server), the way typing "@game Palworld" does in the app. The IDs come from
// Discord's public list of the games it knows (GET /applications/detectable, some 25,000), read
// once a day and kept in memory as name -> ID, its other names included.
const { normalize } = require('./gameLinks')

const DETECTABLE = 'https://discord.com/api/v10/applications/detectable'
const REFRESH_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 60 * 1000

let index = null
let loadedAt = 0
let loading = null

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
  index = buildIndex(await res.json())
  loadedAt = Date.now()
  return index
}

// The index, read again once a day. If reading fails, the old one is kept (or none).
async function games (options) {
  if (index && Date.now() - loadedAt < REFRESH_MS) return index
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
  const byName = await games(options)
  if (!byName) return null
  for (const name of names.filter(Boolean)) {
    const hit = byName.get(normalize(name))
    if (hit) return { ...hit, mention: `<@$${hit.id}>` }
  }
  return null
}

function reset () {
  index = null
  loadedAt = 0
}

module.exports = { findGame, buildIndex, games, reset }
