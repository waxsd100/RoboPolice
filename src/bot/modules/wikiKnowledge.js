// The community's wiki as knowledge for the mention assistant: its characters, quotes and running
// jokes. WIKI_URLS (comma-separated top pages) names the wikis; each is read in full once a week
// (WIKI_REFRESH_HOURS), politely (one page every WIKI_DELAY_MS, only the /d/ pages its robots.txt
// allows), split at its headings and embedded. The model searches it with search_wiki, and the
// emoji describer is told who its characters are.
//
// Runs on the worker owning shard 0, like the other jobs for every server.
const crypto = require('crypto')
const urlFetcher = require('../utils/urlFetcher')
const { parseWikiPage } = require('../utils/wikiPage')
const { embed, embedQuery, model } = require('../utils/embeddings')
const { isGatewayConfigured } = require('../utils/aiGateway')
const store = require('../../db/interfaces/postgres/wiki')

const DEFAULT_REFRESH_HOURS = 168
const DEFAULT_DELAY_MS = 1000
const MAX_PAGES = 300
const EMBED_BATCH = 100
const CHECK_EVERY_MS = 60 * 60 * 1000
const MAX_RESULT_TEXT = 700

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function wikiRoots () {
  return String(process.env.WIKI_URLS || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(u => { try { return new URL(u) } catch (_) { return null } })
    .filter(Boolean)
}

function enabled () {
  return wikiRoots().length !== 0
}

function setting (name, fallback) {
  const n = Number(process.env[name])
  return process.env[name] && Number.isFinite(n) && n >= 0 ? n : fallback
}

// Reads every page reachable from `root` within its wiki. Resolves to the URLs read.
async function crawl (root, { fetchPage = urlFetcher.fetchPageHtml, delay = setting('WIKI_DELAY_MS', DEFAULT_DELAY_MS), log = () => {} } = {}) {
  const queue = [root.toString()]
  const seen = new Set(queue)
  const read = []
  while (queue.length && read.length < MAX_PAGES) {
    const url = queue.shift()
    try {
      const { html } = await fetchPage(url)
      const page = parseWikiPage(html, url)
      await store.savePage(url, page.title || url, page.sections)
      read.push(url)
      for (const link of page.links) {
        if (!seen.has(link)) {
          seen.add(link)
          queue.push(link)
        }
      }
    } catch (e) {
      log(`Could not read ${url}: ${e.message}`)
    }
    if (queue.length) await sleep(delay)
  }
  return read
}

// Embeds the parts that have no embedding by the current model. Resolves to how many.
async function embedPending () {
  const current = model()
  let done = 0
  for (;;) {
    const batch = await store.sectionsToEmbed(current, EMBED_BATCH)
    if (batch.length === 0) return done
    const vectors = await embed(batch.map(s => `${s.title} / ${s.heading}\n${s.text}`))
    for (const [i, s] of batch.entries()) await store.saveSectionEmbedding(s.url, s.position, vectors[i], current)
    done += batch.length
  }
}

// Reads the wikis not read within WIKI_REFRESH_HOURS, then embeds what is new.
let running = false
async function refresh ({ force = false } = {}) {
  if (running || !enabled()) return null
  running = true
  try {
    const maxAge = setting('WIKI_REFRESH_HOURS', DEFAULT_REFRESH_HOURS) * 3600 * 1000
    for (const root of wikiRoots()) {
      const last = await store.lastRead(root.origin)
      if (!force && last && Date.now() - new Date(last).getTime() < maxAge) continue
      const read = await crawl(root, { log: m => global.logger.warn(`[WIKI]: ${m}`) })
      // Only after a read that found pages: a site that was down deletes nothing.
      const gone = read.length ? await store.deletePagesExcept(root.origin, read) : 0
      global.logger.info(`[WIKI]: Read ${read.length} page(s) of ${root.origin}${gone ? `, ${gone} gone` : ''}`)
    }
    if (isGatewayConfigured()) {
      const embedded = await embedPending()
      if (embedded) global.logger.info(`[WIKI]: Embedded ${embedded} part(s)`)
    }
    // Emojis described before the wiki said who the characters are get described again.
    require('./emojiDescriber').startDescriber()
    return true
  } catch (e) {
    global.logger.warn(`[WIKI]: Refresh failed, trying again later: ${e.message}`)
    return null
  } finally {
    running = false
  }
}

function startWiki () {
  if (!enabled()) return null
  global.logger.startup(`[WIKI]: Reading ${wikiRoots().map(r => r.origin).join(', ')} as knowledge.`)
  refresh()
  return setInterval(() => refresh(), CHECK_EVERY_MS)
}

// The wiki parts closest in meaning to `query`, as the search_wiki tool returns them.
async function searchWiki (query, { limit = 5 } = {}) {
  if (!enabled()) return 'wiki は設定されていません'
  if (!await store.hasSections()) return 'wiki はまだ読み込まれていません（しばらくすると読み込まれます）'
  const found = await store.nearestSections(await embedQuery(query), model(), limit)
  if (!found.length) return `wiki に「${query}」に近い記述は見つかりませんでした`
  return [
    `wiki で「${query}」に意味が近い記述（近い順）:`,
    ...found.map(s => `- ${s.title} / ${s.heading}（${s.url}）\n${s.text.slice(0, MAX_RESULT_TEXT)}${s.text.length > MAX_RESULT_TEXT ? '…' : ''}`)
  ].join('\n')
}

// Who the wiki's characters are, for describing emojis: { text, hash }, text empty when unknown.
async function characterContext () {
  if (!enabled()) return { text: '', hash: null }
  const rows = await store.characters().catch(() => [])
  const text = rows.map(r => `- ${r.heading}: ${r.text.replace(/\s+/g, ' ').slice(0, 100)}`).join('\n').slice(0, 6000)
  return { text, hash: text ? crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) : null }
}

module.exports = { startWiki, refresh, crawl, embedPending, searchWiki, characterContext, enabled, wikiRoots }
