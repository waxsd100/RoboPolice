// Reading public Steam profiles, games, reviews and wishlists without needing a Steam Web API key
// (and also reading IPlayerService/GetOwnedGames when STEAM_API_KEY is set).
//
// Public endpoints used without an API key:
// - https://steamcommunity.com/id/<vanity>/?xml=1 (or /profiles/<steamid64>/?xml=1): SteamID64,
//   persona name, bio, member since, and recently played games with hours on record.
// - https://steamcommunity.com/id/<vanity>/ and /badges/: level, total owned game count, showcase
//   and badge gamecard AppIDs.
// - https://steamcommunity.com/id/<vanity>/recommended/?p=N: all reviews written by the user, with
//   recommended/not-recommended, hours on record, posted date and text.
// - ISaleFeatureService/GetUserYearInReview/v1: every game played in each year's Steam Replay
//   (2022..current year) with playtime and first-played timestamp.
// - IWishlistService/GetWishlist/v1: wishlisted AppIDs, priority and date added.
// - IStoreBrowseService/GetItems/v1: Japanese and English store names for batches of up to 100 AppIDs.
const { decodeEntities } = require('./urlFetcher')

const COMMUNITY = 'https://steamcommunity.com'
const API = 'https://api.steampowered.com'
const TIMEOUT_MS = 20 * 1000
const STORE_BATCH_SIZE = 100
const FIRST_REPLAY_YEAR = 2022

function profileBaseUrl (ref) {
  const clean = String(ref || '').trim()
    .replace(/^https?:\/\/steamcommunity\.com\/(id|profiles)\//i, '')
    .replace(/\/.*$/, '')
  if (/^\d{17}$/.test(clean)) return `${COMMUNITY}/profiles/${clean}`
  return `${COMMUNITY}/id/${encodeURIComponent(clean)}`
}

function stripHtml (html) {
  return decodeEntities(String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseHours (text) {
  const m = String(text || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/)
  return m ? Math.round(Number(m[1]) * 10) / 10 : null
}

async function fetchText (url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: {
      'User-Agent': 'RoboPolice (+https://github.com/waxsd100/RoboPolice)',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`Steam ${url}: HTTP ${res.status}`)
  return res.text()
}

async function fetchJSON (url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'RoboPolice (+https://github.com/waxsd100/RoboPolice)' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`Steam ${url}: HTTP ${res.status}`)
  return res.json()
}

// Parses the XML profile (?xml=1) and optional HTML profile/badges pages.
function parseProfileXml (xml) {
  const steamId = xml.match(/<steamID64>(\d+)<\/steamID64>/)?.[1]
  if (!steamId) {
    const err = xml.match(/<error><!\[CDATA\[([\s\S]*?)\]\]><\/error>/)?.[1]
    throw new Error(err || 'Steam profile not found')
  }
  const cdata = tag => xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))?.[1]?.trim() ||
    xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim() || null
  const recentGames = []
  for (const m of xml.matchAll(/<mostPlayedGame>([\s\S]*?)<\/mostPlayedGame>/g)) {
    const block = m[1]
    const link = block.match(/<gameLink>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/gameLink>/)?.[1] || ''
    const appId = Number(link.match(/\/app\/(\d+)/)?.[1])
    const name = block.match(/<gameName><!\[CDATA\[([\s\S]*?)\]\]><\/gameName>/)?.[1]?.trim()
    const recentHours = parseHours(block.match(/<hoursPlayed>([\s\S]*?)<\/hoursPlayed>/)?.[1])
    const playtimeHours = parseHours(block.match(/<hoursOnRecord>([\s\S]*?)<\/hoursOnRecord>/)?.[1])
    if (appId && name) recentGames.push({ appId, name: decodeEntities(name), recentHours, playtimeHours })
  }
  return {
    steamId,
    personaName: cdata('steamID') ? decodeEntities(cdata('steamID')) : null,
    customUrl: cdata('customURL') || null,
    memberSince: cdata('memberSince') || null,
    summary: cdata('summary') ? stripHtml(cdata('summary')) : null,
    recentGames
  }
}

function parseProfileHtml (html) {
  const levelMatch = html.match(/class="friendPlayerLevelNum">(\d+)<\/span>/)
  const gamesMatch = html.match(/\/games\/\?tab=all[\s\S]{0,400}?profile_count_link_total">\s*([\d,]+)\s*<\/span>/)
  const appIds = new Set()
  for (const m of html.matchAll(/(?:\/(?:app|achievements|gamecards)\/(\d+)|\/stats\/(\d+)\/achievements)/g)) {
    const id = Number(m[1] || m[2])
    if (id > 0) appIds.add(id)
  }
  return {
    level: levelMatch ? Number(levelMatch[1]) : null,
    gameCount: gamesMatch ? Number(gamesMatch[1].replace(/,/g, '')) : null,
    appIds: [...appIds]
  }
}

async function getProfile (ref, options = {}) {
  const base = profileBaseUrl(ref)
  const xml = await fetchText(`${base}/?xml=1`, options)
  const parsed = parseProfileXml(xml)
  let level = null
  let gameCount = null
  const appIds = new Set(parsed.recentGames.map(g => g.appId))
  try {
    const html = await fetchText(`${base}/?l=japanese`, options)
    const extra = parseProfileHtml(html)
    level = extra.level
    gameCount = extra.gameCount
    for (const id of extra.appIds) appIds.add(id)
  } catch (_) {}
  try {
    const badgesHtml = await fetchText(`${base}/badges/?l=japanese`, options)
    for (const id of parseProfileHtml(badgesHtml).appIds) appIds.add(id)
  } catch (_) {}
  return {
    ...parsed,
    level,
    gameCount,
    discoveredAppIds: [...appIds]
  }
}

// Parses one HTML page of /recommended/?p=N into review objects.
function parseReviewsHtml (html, baseUrl) {
  const reviews = []
  const parts = String(html || '').split('<div class="review_box_content">').slice(1)
  for (const part of parts) {
    const appId = Number(part.match(/\/app\/(\d+)/)?.[1])
    if (!appId) continue
    const recommended = /icon_thumbsUp/i.test(part) || (!/icon_thumbsDown/i.test(part) && /おすすめ/.test(part))
    const hoursRaw = part.match(/<div class="hours">([\s\S]*?)<\/div>/)?.[1] || ''
    const hoursOnRecord = parseHours(hoursRaw)
    const postedRaw = part.match(/<div class="posted">([\s\S]*?)<\/div>/)?.[1] || ''
    const posted = stripHtml(postedRaw).replace(/^(?:投稿日[：:\s]*|Posted[：:\s]*)/i, '').replace(/\.$/, '').trim() || null
    const contentRaw = part.match(/<div class="content\s*">([\s\S]*?)<\/div>\s*<div class="posted">/)?.[1] || ''
    const content = stripHtml(contentRaw)
    if (!content) continue
    reviews.push({
      appId,
      recommended,
      hoursOnRecord,
      posted,
      content,
      url: `${baseUrl.replace(/\/$/, '')}/recommended/${appId}/`
    })
  }
  return reviews
}

async function getReviews (ref, { maxPages = 20, ...options } = {}) {
  const base = profileBaseUrl(ref)
  const seen = new Set()
  const out = []
  for (let p = 1; p <= maxPages; p++) {
    const html = await fetchText(`${base}/recommended/?p=${p}&l=japanese`, options)
    const pageReviews = parseReviewsHtml(html, base).filter(r => !seen.has(r.appId) && seen.add(r.appId))
    if (!pageReviews.length) break
    out.push(...pageReviews)
    if (!html.includes(`?p=${p + 1}`)) break
  }
  return out
}

// Reads Steam Replay (Year in Review) for each year and aggregates playtime and first-played date.
async function getReplayGames (steamId, { years, now = new Date(), ...options } = {}) {
  const currentYear = now.getUTCFullYear()
  const targetYears = years || Array.from({ length: Math.max(1, currentYear - FIRST_REPLAY_YEAR + 1) }, (_, i) => FIRST_REPLAY_YEAR + i)
  const byApp = new Map() // appId -> { seconds, firstPlayedAt }

  for (const year of targetYears) {
    let data
    try {
      data = await fetchJSON(`${API}/ISaleFeatureService/GetUserYearInReview/v1/?steamid=${encodeURIComponent(steamId)}&year=${year}`, options)
    } catch (_) {
      continue
    }
    const stats = data?.response?.stats?.playtime_stats
    if (!stats) continue
    const totalSeconds = Number(stats.total_stats?.total_playtime_seconds) || 0
    const detailedInYear = new Set()

    for (const g of stats.games || []) {
      const appId = Number(g.appid)
      if (!appId) continue
      const sec = Number(g.stats?.total_playtime_seconds) || 0
      detailedInYear.add(appId)
      const prev = byApp.get(appId) || { seconds: 0, firstPlayedAt: null }
      prev.seconds += sec
      byApp.set(appId, prev)
    }

    for (const g of stats.game_summary || []) {
      const appId = Number(g.appid)
      if (!appId) continue
      const prev = byApp.get(appId) || { seconds: 0, firstPlayedAt: null }
      if (!detailedInYear.has(appId) && totalSeconds > 0 && Number(g.total_playtime_percentagex100) > 0) {
        prev.seconds += (totalSeconds * Number(g.total_playtime_percentagex100)) / 10000
      }
      const firstTs = Number(g.rtime_first_played_lifetime)
      if (firstTs > 0) {
        const d = new Date(firstTs * 1000)
        if (!prev.firstPlayedAt || d < prev.firstPlayedAt) prev.firstPlayedAt = d
      }
      byApp.set(appId, prev)
    }
  }

  return [...byApp.entries()].map(([appId, v]) => ({
    appId,
    playtimeHours: v.seconds > 0 ? Math.round((v.seconds / 3600) * 10) / 10 : null,
    firstPlayedAt: v.firstPlayedAt
  }))
}

// Optional: when STEAM_API_KEY is set, IPlayerService/GetOwnedGames/v1 returns the full owned games
// list with exact lifetime playtime.
async function getOwnedGamesApi (steamId, { apiKey = process.env.STEAM_API_KEY, ...options } = {}) {
  if (!apiKey) return []
  const url = `${API}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(apiKey)}&steamid=${encodeURIComponent(steamId)}&include_appinfo=true&include_played_free_games=true`
  const data = await fetchJSON(url, options)
  const games = data?.response?.games || []
  return games.filter(g => Number(g.appid) > 0).map(g => ({
    appId: Number(g.appid),
    name: g.name ? String(g.name).trim() : null,
    playtimeHours: Number(g.playtime_forever) > 0 ? Math.round((Number(g.playtime_forever) / 60) * 10) / 10 : 0,
    recentHours: Number(g.playtime_2weeks) > 0 ? Math.round((Number(g.playtime_2weeks) / 60) * 10) / 10 : null,
    lastPlayedAt: Number(g.rtime_last_played) > 0 ? new Date(Number(g.rtime_last_played) * 1000) : null
  }))
}

async function getWishlist (steamId, options = {}) {
  const data = await fetchJSON(`${API}/IWishlistService/GetWishlist/v1/?steamid=${encodeURIComponent(steamId)}`, options)
  const items = data?.response?.items || []
  return items.filter(i => Number(i.appid) > 0).map(i => ({
    appId: Number(i.appid),
    priority: Number.isInteger(i.priority) ? i.priority : null,
    addedAt: Number(i.date_added) > 0 ? new Date(Number(i.date_added) * 1000) : null
  }))
}

async function fetchStoreNames (appIds, language, options = {}) {
  const out = new Map()
  for (let i = 0; i < appIds.length; i += STORE_BATCH_SIZE) {
    const chunk = appIds.slice(i, i + STORE_BATCH_SIZE)
    const input = {
      ids: chunk.map(appid => ({ appid })),
      context: { language, country_code: 'JP' },
      data_request: { include_basic_info: true }
    }
    const url = `${API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`
    const data = await fetchJSON(url, options)
    for (const item of data?.response?.store_items || []) {
      if (item.appid && item.name) out.set(Number(item.appid), String(item.name).trim())
    }
  }
  return out
}

// Resolves Japanese and English store names for the given AppIDs in batches of 100.
async function resolveApps (appIds, options = {}) {
  const unique = [...new Set(appIds.map(Number).filter(n => n > 0))]
  if (!unique.length) return []
  const [ja, en] = await Promise.all([
    fetchStoreNames(unique, 'japanese', options),
    fetchStoreNames(unique, 'english', options).catch(() => new Map())
  ])
  const results = []
  for (const appId of unique) {
    const name = ja.get(appId) || en.get(appId)
    if (!name) continue
    const nameEn = en.get(appId) && en.get(appId) !== name ? en.get(appId) : null
    results.push({ appId, name, nameEn })
  }
  return results
}

module.exports = {
  profileBaseUrl,
  parseProfileXml,
  parseProfileHtml,
  parseReviewsHtml,
  getProfile,
  getReviews,
  getReplayGames,
  getOwnedGamesApi,
  getWishlist,
  resolveApps
}
