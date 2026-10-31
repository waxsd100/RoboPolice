// The streamer's own X (Twitter) posts as knowledge, next to the wiki (wikiKnowledge.js).
// TWITTER_ACCOUNTS names the accounts (comma-separated, without @). Their posts are read through
// FxTwitter's public API (api.fxtwitter.com), newest first, page by page: the first time up to
// TWITTER_MAX_PAGES pages back, afterwards until posts already stored. Reposts of others are left
// out; replies are kept. Every TWITTER_REFRESH_HOURS (default 6), one request every 2 seconds.
//
// Posts are stored in x_posts. Each month's posts also become one page of the X knowledge tables
// (x_pages / x_sections / x_facts; title "@account のポスト（2026年10月）", one line per post with its
// date and URL), so knowledge is taken out of them and they are searched with search_wiki like the
// wiki, whose tables are separate. Only the months with new posts are written again, and
// within them only the parts that changed are read again.
//
// FxTwitter is a third-party service, not X's API: it may change or stop. When it fails, nothing
// stored is lost and the next run tries again.
const knowledgeStore = require('../../db/interfaces/postgres/xKnowledge')
const store = require('../../db/interfaces/postgres/xPosts')

const API = 'https://api.fxtwitter.com/2/profile'
const DEFAULT_REFRESH_HOURS = 6
const DEFAULT_MAX_PAGES = 100
const DELAY_MS = 2000
const MAX_PART = 1500
const TIMEOUT_MS = 20 * 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function accounts () {
  return String(process.env.TWITTER_ACCOUNTS || '').split(',').map(s => s.trim().replace(/^@/, '')).filter(a => /^\w{1,15}$/.test(a))
}

function enabled () {
  return accounts().length !== 0
}

function setting (name, fallback) {
  const n = Number(process.env[name])
  return process.env[name] && Number.isFinite(n) && n > 0 ? n : fallback
}

const TRIES = 3

// FxTwitter now and then answers a request it answers fine a moment later with 404 or 5xx, so a
// failed request is tried again a few times before giving up.
async function getJSON (url, { fetchImpl = fetch, wait = sleep } = {}) {
  let last
  for (let i = 0; i < TRIES; i++) {
    if (i) await wait(DELAY_MS * 2 * i)
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': 'RoboPolice (+https://github.com/waxsd100/RoboPolice)' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (res.ok) return res.json()
      last = new Error(`FxTwitter ${url}: HTTP ${res.status}`)
    } catch (e) {
      last = e
    }
  }
  throw last
}

// A post as stored, or null for a repost of someone else's.
function toPost (t, account) {
  if (t.reposted_by || String(t.author?.screen_name || '').toLowerCase() !== account.toLowerCase()) return null
  return {
    id: String(t.id),
    account,
    url: t.url || `https://x.com/${account}/status/${t.id}`,
    text: String(t.text || '').trim(),
    createdAt: new Date(t.created_timestamp ? t.created_timestamp * 1000 : t.created_at),
    replyTo: t.replying_to?.screen_name || null,
    mediaUrls: [...(t.media?.photos || []), ...(t.media?.videos || [])].map(m => m.url).filter(Boolean)
  }
}

// The account's posts, newest first, until `known` posts or `maxPages` pages.
async function readTimeline (account, { known = new Set(), maxPages = setting('TWITTER_MAX_PAGES', DEFAULT_MAX_PAGES), fetchJSON = getJSON, delay = DELAY_MS } = {}) {
  const posts = []
  let cursor = null
  for (let page = 0; page < maxPages; page++) {
    const data = await fetchJSON(`${API}/${encodeURIComponent(account)}/statuses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
    const results = data.results || []
    const own = results.map(t => toPost(t, account)).filter(Boolean)
    posts.push(...own.filter(p => !known.has(p.id)))
    // A page whose own posts are all stored already: everything older is stored too.
    if (!results.length || (own.length && own.every(p => known.has(p.id)))) break
    cursor = data.cursor?.bottom
    if (!cursor) break
    await sleep(delay)
  }
  return posts
}

const monthOf = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(date)
const dayOf = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(date)
const pageUrl = (account, month) => `https://x.com/${account}#${month}`

// One month's posts as the parts of a page: one line per post, cut into parts of at most MAX_PART.
function monthSections (account, month, posts) {
  const [year, m] = month.split('-')
  const lines = posts.map(p => `[${dayOf(new Date(p.created_at))}]${p.reply_to ? ` @${p.reply_to} への返信:` : ''} ${p.text.replace(/\s+/g, ' ')} ${p.url}`)
  const sections = []
  let current = []
  for (const line of lines) {
    if (current.length && [...current, line].join('\n').length > MAX_PART) {
      sections.push(current)
      current = []
    }
    current.push(line.slice(0, MAX_PART))
  }
  if (current.length) sections.push(current)
  return {
    title: `@${account} のポスト（${year}年${Number(m)}月）`,
    sections: sections.map((s, i) => ({ heading: `${year}年${Number(m)}月 ${i + 1}`, text: s.join('\n'), images: [] }))
  }
}

// Reads new posts of every account and writes the months they are in. Resolves to how many were new.
let running = false
async function refresh ({ fetchJSON } = {}) {
  if (running || !enabled()) return null
  running = true
  try {
    let added = 0
    for (const account of accounts()) {
      const known = await store.knownIds(account)
      const posts = await readTimeline(account, { known, ...(fetchJSON ? { fetchJSON, delay: 0 } : {}) })
      const fresh = await store.savePosts(posts)
      for (const month of new Set(fresh.map(p => monthOf(p.createdAt)))) {
        const page = monthSections(account, month, await store.postsOfMonth(account, month))
        await knowledgeStore.savePage(pageUrl(account, month), page.title, page.sections)
      }
      if (fresh.length) global.logger.info(`[X]: ${fresh.length} new post(s) of @${account}`)
      added += fresh.length
    }
    if (added) await require('./wikiKnowledge').processPending(m => global.logger.warn(`[X]: ${m}`))
    return added
  } catch (e) {
    global.logger.warn(`[X]: Reading posts failed, trying again later: ${e.message}`)
    return null
  } finally {
    running = false
  }
}

function startTwitter () {
  if (!enabled()) return null
  global.logger.startup(`[X]: Reading the posts of ${accounts().map(a => `@${a}`).join(', ')} as knowledge.`)
  refresh()
  return setInterval(() => refresh(), setting('TWITTER_REFRESH_HOURS', DEFAULT_REFRESH_HOURS) * 3600 * 1000)
}

module.exports = { startTwitter, refresh, readTimeline, getJSON, toPost, monthSections, accounts, enabled }
