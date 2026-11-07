// The Steam accounts the bot follows (STEAM_ACCOUNTS: vanity IDs or 17-digit SteamID64s,
// comma-separated; the same for every server): their profile, owned/played games, reviews and
// wishlist, read every STEAM_SYNC_MINUTES (default 360, 6 hours) by the worker owning shard 0.
// Works without an API key using Steam Community XML/HTML, Steam Replay, Wishlist and Store Browse
// endpoints, and also uses IPlayerService/GetOwnedGames when STEAM_API_KEY is set.
//
// The streamer's Steam reviews are also written to the knowledge tables (source 'web') so their
// opinions and quotes are extracted and embedded for search_wiki alongside X and the wiki.
const { knowledgeSetting } = require('../utils/knowledgeDefaults')
const steam = require('../utils/steam')
const store = require('../../db/interfaces/postgres/steam')
const webStore = require('../../db/interfaces/postgres/webKnowledge')

const DEFAULT_SYNC_MINUTES = 360
const MAX_PART = 1500

function accounts () {
  return [...new Set(
    String(knowledgeSetting('STEAM_ACCOUNTS'))
      .split(',')
      .map(s => s.trim().replace(/^@/, '').replace(/^https?:\/\/steamcommunity\.com\/(?:id|profiles)\//i, '').replace(/\/.*$/, ''))
      .filter(a => /^[\w-]{2,64}$/.test(a))
  )]
}

function enabled () {
  return accounts().length !== 0
}

async function resolveUnknownApps (appIds, options = {}) {
  const unique = [...new Set(appIds.map(Number).filter(n => n > 0))]
  const known = await store.knownApps(unique)
  const missing = unique.filter(id => !known.has(id))
  if (missing.length) {
    const resolved = await steam.resolveApps(missing, options)
    await store.saveApps(resolved)
    for (const a of resolved) known.set(a.appId, { name: a.name, nameEn: a.nameEn })
  }
  return known
}

// Formats an account's Steam reviews into knowledge sections (at most MAX_PART characters each)
// so wikiKnowledge extracts quotes/facts and embeds them.
function reviewSections (personaName, accountRef, reviews) {
  const who = personaName || accountRef
  const lines = reviews.map(r => {
    const label = r.recommended ? 'おすすめ' : 'おすすめしない'
    const hours = Number.isFinite(r.hoursOnRecord) ? `（総プレイ ${r.hoursOnRecord} 時間）` : ''
    const posted = r.posted ? ` [${r.posted}]` : ''
    return `【${r.name || `App ${r.appId}`}】${label}${hours}${posted}: ${r.content.replace(/\s+/g, ' ')} ${r.url}`
  })
  const parts = []
  let current = []
  for (const line of lines) {
    if (current.length && [...current, line].join('\n').length > MAX_PART) {
      parts.push(current)
      current = []
    }
    current.push(line.slice(0, MAX_PART))
  }
  if (current.length) parts.push(current)
  return {
    title: `${who} の Steam レビュー一覧`,
    sections: parts.map((p, i) => ({ heading: `Steam レビュー ${i + 1}`, text: p.join('\n'), images: [] }))
  }
}

async function applyProfiles (options = {}) {
  const wanted = accounts()
  const profiles = []
  for (const ref of wanted) {
    const p = await steam.getProfile(ref, options)
    profiles.push({ ...p, accountRef: ref })
  }
  await store.setProfiles(profiles)
  return profiles
}

function maxNumber (...values) {
  const nums = values.filter(v => Number.isFinite(v) && v >= 0)
  return nums.length ? Math.max(...nums) : null
}

async function syncAccount (profileRow, options = {}) {
  const ref = profileRow.custom_url || profileRow.account_ref || profileRow.steam_id
  const profile = await steam.getProfile(ref, options)
  const [reviews, replayGames, apiGames, rawWishlist] = await Promise.all([
    steam.getReviews(profile.customUrl || profile.steamId, options).catch(() => []),
    steam.getReplayGames(profile.steamId, options).catch(() => []),
    steam.getOwnedGamesApi(profile.steamId, options).catch(() => []),
    steam.getWishlist(profile.steamId, options).catch(() => [])
  ])

  const allAppIds = [
    ...(profile.discoveredAppIds || []),
    ...profile.recentGames.map(g => g.appId),
    ...reviews.map(r => r.appId),
    ...replayGames.map(g => g.appId),
    ...apiGames.map(g => g.appId),
    ...rawWishlist.map(w => w.appId)
  ]
  const appMap = await resolveUnknownApps(allAppIds, options)

  const byApp = new Map()
  const ensure = appId => {
    if (!byApp.has(appId)) {
      byApp.set(appId, {
        appId,
        fallbackName: null,
        playtimeHours: null,
        recentHours: null,
        firstPlayedAt: null,
        lastPlayedAt: null
      })
    }
    return byApp.get(appId)
  }

  for (const appId of profile.discoveredAppIds || []) ensure(appId)
  for (const g of replayGames) {
    const entry = ensure(g.appId)
    entry.playtimeHours = maxNumber(entry.playtimeHours, g.playtimeHours)
    if (g.firstPlayedAt && (!entry.firstPlayedAt || g.firstPlayedAt < entry.firstPlayedAt)) {
      entry.firstPlayedAt = g.firstPlayedAt
    }
  }
  for (const r of reviews) {
    const entry = ensure(r.appId)
    entry.playtimeHours = maxNumber(entry.playtimeHours, r.hoursOnRecord)
  }
  for (const g of profile.recentGames) {
    const entry = ensure(g.appId)
    entry.fallbackName = entry.fallbackName || g.name
    entry.playtimeHours = maxNumber(entry.playtimeHours, g.playtimeHours)
    entry.recentHours = maxNumber(entry.recentHours, g.recentHours)
  }
  for (const g of apiGames) {
    const entry = ensure(g.appId)
    entry.fallbackName = entry.fallbackName || g.name
    entry.playtimeHours = maxNumber(entry.playtimeHours, g.playtimeHours)
    entry.recentHours = maxNumber(entry.recentHours, g.recentHours)
    if (g.lastPlayedAt && (!entry.lastPlayedAt || g.lastPlayedAt > entry.lastPlayedAt)) {
      entry.lastPlayedAt = g.lastPlayedAt
    }
  }

  const games = [...byApp.values()].map(g => {
    const resolved = appMap.get(g.appId)
    return {
      appId: g.appId,
      name: resolved?.name || g.fallbackName || `App ${g.appId}`,
      nameEn: resolved?.nameEn || (resolved?.name && g.fallbackName && g.fallbackName !== resolved.name ? g.fallbackName : null),
      playtimeHours: g.playtimeHours,
      recentHours: g.recentHours,
      firstPlayedAt: g.firstPlayedAt,
      lastPlayedAt: g.lastPlayedAt
    }
  }).filter(g => !/^App \d+$/.test(g.name) || Number.isFinite(g.playtimeHours))

  const namedReviews = reviews.map(r => ({
    ...r,
    name: appMap.get(r.appId)?.name || byApp.get(r.appId)?.fallbackName || `App ${r.appId}`
  }))

  const wishlist = rawWishlist.map(w => {
    const resolved = appMap.get(w.appId)
    if (!resolved?.name) return null
    return {
      appId: w.appId,
      name: resolved.name,
      nameEn: resolved.nameEn || null,
      priority: w.priority,
      addedAt: w.addedAt
    }
  }).filter(Boolean)

  const res = await store.saveAccountData(profile.steamId, {
    profile: { ...profile, wishlistCount: rawWishlist.length || null },
    games,
    reviews: namedReviews.length ? namedReviews : null,
    wishlist: wishlist.length ? wishlist : null
  })

  if (namedReviews.length) {
    const pageUrl = `${steam.profileBaseUrl(profile.customUrl || profile.steamId)}/recommended/`
    const page = reviewSections(profile.personaName, profileRow.account_ref, namedReviews)
    await webStore.savePage(pageUrl, page.title, page.sections)
  }

  return res
}

async function syncAll (options = {}) {
  let newGames = 0
  let newReviews = 0
  for (const profile of await store.listProfiles()) {
    const res = await syncAccount(profile, options)
    newGames += res.newGames
    newReviews += res.newReviews
  }
  if (newReviews) {
    await require('./wikiKnowledge').processPending(m => global.logger.warn(`[STEAM]: ${m}`)).catch(() => {})
  }
  return { newGames, newReviews }
}

let running = false
async function runOnce (options = {}) {
  if (running || !enabled()) return null
  running = true
  try {
    await applyProfiles(options).catch(e => global.logger.warn(`[STEAM]: Could not resolve STEAM_ACCOUNTS, keeping those followed: ${e.message}`))
    const { newGames, newReviews } = await syncAll(options)
    if (newGames || newReviews) global.logger.info(`[STEAM]: ${newGames} new game(s), ${newReviews} new review(s)`)
    return { newGames, newReviews }
  } catch (e) {
    global.logger.warn(`[STEAM]: Sync failed: ${e.message}`)
    return null
  } finally {
    running = false
  }
}

function startSteam () {
  if (!enabled()) return null
  const n = Number(process.env.STEAM_SYNC_MINUTES)
  const minutes = process.env.STEAM_SYNC_MINUTES && Number.isFinite(n) && n >= 10 ? n : DEFAULT_SYNC_MINUTES
  global.logger.startup?.(`[STEAM]: Following ${accounts().join(', ')}.`)
  runOnce()
  return setInterval(runOnce, minutes * 60 * 1000)
}

module.exports = { accounts, enabled, applyProfiles, syncAccount, syncAll, runOnce, startSteam, reviewSections }
