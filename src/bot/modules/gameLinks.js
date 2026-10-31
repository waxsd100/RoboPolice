// Where a game can be found: its Steam store page when it is on Steam (the store's own search),
// else an official page Gemini finds with Google Search (the game's site, or its PlayStation,
// Nintendo, Xbox or app store page). A link is only given once the page has been read: a guessed
// URL that does not open is left out. GAME_LINKS=false turns this off.
const urlFetcher = require('../utils/urlFetcher')
const { callGemini, DEFAULT_GEMINI_MODEL } = require('./eventDrafter')

const STEAM_SEARCH = 'https://store.steampowered.com/api/storesearch/'
const TIMEOUT_MS = 15 * 1000

function enabled () {
  return process.env.GAME_LINKS !== 'false'
}

// For comparing names: no case, spaces, punctuation or width differences.
const normalize = name => String(name || '').replace(/[™®©]/g, '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

// The Steam store page of the game called `name`, or null. Only a name that matches, not the
// nearest hit: "Minecraft" must not become "Minecraft Dungeons".
async function steamPage (name, { fetchImpl = fetch } = {}) {
  const url = `${STEAM_SEARCH}?term=${encodeURIComponent(name)}&l=japanese&cc=JP`
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Steam search: HTTP ${res.status}`)
  const items = (await res.json()).items || []
  const wanted = normalize(name)
  const hit = items.find(i => i.type === 'app' && normalize(i.name) === wanted)
  return hit ? { name: hit.name, url: `https://store.steampowered.com/app/${hit.id}/` } : null
}

// An official page of the game found with Google Search through Gemini, or null.
async function officialPage (name) {
  const content = await callGemini(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, {
    contents: [{
      role: 'user',
      parts: [{ text: `ゲーム「${name}」の公式サイト、または公式のストアページ（PlayStation Store、Nintendo、Xbox、App Store、Google Play など）の URL を1つだけ、URL のみで答えてください。見つからなければ「なし」とだけ答えてください。` }]
    }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0 }
  }, { timeoutMs: 30 * 1000 })
  const url = content.parts.map(p => p.text || '').join('').match(/https?:\/\/[^\s)」"'<>]+/)?.[0]
  if (!url) return null
  // Only a page that opens: a model can name a URL that does not exist.
  await urlFetcher.fetchPageText(url)
  return { name, url }
}

// [{ name, url }] for the games named (each { name, nameEn }), those with no page found left out.
async function linksFor (games, { log = () => {} } = {}) {
  if (!enabled()) return []
  const links = []
  for (const game of games.slice(0, 3)) {
    const names = [...new Set([game.name, game.nameEn].filter(Boolean))]
    let link = null
    for (const name of names) {
      link = await module.exports.steamPage(name).catch(e => { log(`Steam: ${e.message}`); return null })
      if (link) break
    }
    if (!link) link = await module.exports.officialPage(game.name).catch(e => { log(`No page for ${game.name}: ${e.message}`); return null })
    if (link) links.push({ name: game.name, url: link.url })
  }
  return links
}

module.exports = { linksFor, steamPage, officialPage, normalize, enabled }
