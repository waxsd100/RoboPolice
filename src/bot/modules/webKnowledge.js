// Knowledge looked up on the web, for topics the wiki and the posts say little about, such as the
// groups the streamer belongs to. KNOWLEDGE_TOPICS names them (comma-separated or one per line,
// each with what it is, e.g. "ぽみそしる（のばまんが所属する実況者グループ）"). Each is looked up
// with Gemini's Google Search once every WEB_REFRESH_HOURS (default 168, a week) and written as a
// page of the knowledge tables as source 'web', whose knowledge is then
// taken out and embedded with the wiki's (wikiKnowledge.js), so it is searched with search_wiki.
//
// What search finds can be out of date or wrong; the page says when it was looked up and lists
// its sources, and the model is told not to state it as certain.
const { knowledgeSetting } = require('../utils/knowledgeDefaults')
const { callGemini, resolveTaskConfig } = require('./eventDrafter')
const { isGatewayConfigured } = require('../utils/aiGateway')
const { withoutCharCount } = require('../utils/textClean')
const urlFetcher = require('../utils/urlFetcher')
const backgroundQueue = require('../utils/backgroundQueue')
const store = require('../../db/interfaces/postgres/webKnowledge')

const DEFAULT_REFRESH_HOURS = 168
const MAX_PART = 1500
const PREFIX = 'topic:'
const TIMEOUT_MS = 2 * 60 * 1000

function topics () {
  return [...new Set(String(knowledgeSetting('KNOWLEDGE_TOPICS')).split(/[,\n]/).map(s => s.trim()).filter(Boolean))]
}

function urls () {
  return [...new Set(String(knowledgeSetting('KNOWLEDGE_URLS')).split(/[,\n]/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s)))]
}

function enabled () {
  return topics().length !== 0 || urls().length !== 0
}

function refreshHours () {
  const n = Number(process.env.WEB_REFRESH_HOURS)
  return n > 0 ? n : DEFAULT_REFRESH_HOURS
}

// A topic's name: what comes before its explanation in （）. Its page is kept under the name, so
// rewording the explanation does not make a new page.
const nameOf = topic => topic.split(/[（(]/)[0].trim() || topic
const urlOf = topic => `${PREFIX}${nameOf(topic)}`
const dayOf = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(date)

const prompt = (topic, now) => [
  `今日は ${dayOf(now)} です。Google 検索で調べて、次のテーマについて日本語でまとめてください: ${topic}`,
  '- 何か（グループ・ユニット・企画など）、正式名称と略称・読み',
  '- メンバー（今のメンバーと、卒業・脱退したメンバーがいれば分けて、分かればその時期も）。テーマに書かれたメンバーは手がかりなので、今もそうか確かめる',
  '- 結成・開始の時期、主な活動・企画・作品、ファンネームなど',
  '- 公式サイト・公式 X・YouTube チャンネルなどの URL',
  '見出しごとに短くまとめ、最後に「出典」として参考にしたページの URL を並べてください。',
  '見つかったことだけを書き、分からないことは書かないでください。情報源によって違うときは、その旨を書いてください。前置きや文字数は書かないでください。'
].join('\n')

// The text cut into parts of at most MAX_PART, at blank lines where it can.
function parts (text) {
  const out = []
  let current = ''
  for (const block of text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)) {
    if (current && `${current}\n\n${block}`.length > MAX_PART) {
      out.push(current)
      current = ''
    }
    current = current ? `${current}\n\n${block}` : block.slice(0, MAX_PART)
  }
  if (current) out.push(current)
  return out
}

// Reads a public web page (KNOWLEDGE_URLS) directly and stores its text in parts.
async function readUrl (url, { fetchPage = urlFetcher.fetchPageText } = {}) {
  const page = await fetchPage(url)
  const text = String(page.text || '').trim()
  if (!text) throw new Error(`empty page at ${url}`)
  const title = text.match(/^タイトル:\s*(.+)$/m)?.[1]?.trim() || url
  const sections = parts(text).map((t, i) => ({ heading: `${title} ${i + 1}`, text: t, images: [] }))
  await store.savePage(url, title, sections)
  return sections.length
}

// Looks the topic up and stores what was found. Resolves to how many parts were written.
async function lookUp (topic, now = new Date(), { guildID = null } = {}) {
  const { model: m, thinking, flex } = await resolveTaskConfig('light', guildID)
  const content = await backgroundQueue.run(guildID, () => callGemini(m, {
    contents: [{ role: 'user', parts: [{ text: prompt(topic, now) }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2, ...thinking }
  }, { timeoutMs: TIMEOUT_MS, purpose: 'webKnowledge', ...(flex ? { flex: true } : {}) }))
  const text = withoutCharCount(content.parts.map(p => p.text || '').join('').trim())
  if (!text) throw new Error(`nothing found about ${topic}`)
  const title = `「${nameOf(topic)}」について（Web 検索で調べたもの、${dayOf(now)} 時点）`
  const sections = parts(text).map((t, i) => ({ heading: `${nameOf(topic)} ${i + 1}`, text: t, images: [] }))
  await store.savePage(urlOf(topic), title, sections)
  return sections.length
}

async function readPageTimestamp (pageUrl) {
  if (typeof store.pageLastRead === 'function' && (store.pageLastRead.mock || !store.lastRead?.mock)) {
    return store.pageLastRead(pageUrl)
  }
  return store.lastRead(pageUrl)
}

// Looks up the topics and URLs not read within WEB_REFRESH_HOURS, and drops the pages of topics or
// URLs no longer named. One that fails is tried again at the next check. Resolves to how many were read.
let running = false
async function refresh ({ force = false, now = new Date(), fetchPage, log = m => global.logger.warn(m) } = {}) {
  if (running) return 0
  running = true
  try {
    let done = 0
    const wantedUrls = urls()
    for (const url of wantedUrls) {
      const last = await readPageTimestamp(url)
      if (!force && last && now - new Date(last) < refreshHours() * 3600 * 1000) continue
      try {
        await readUrl(url, { fetchPage })
        done++
      } catch (e) {
        log(`[WEB]: Could not read ${url}: ${e.message}`)
      }
    }
    const wanted = topics()
    if (wanted.length && isGatewayConfigured()) {
      for (const topic of wanted) {
        const last = await readPageTimestamp(urlOf(topic))
        if (!force && last && now - new Date(last) < refreshHours() * 3600 * 1000) continue
        try {
          await lookUp(topic, now)
          done++
        } catch (e) {
          log(`[WEB]: Could not look up ${topic}: ${e.message}`)
        }
      }
    }
    await store.deletePagesExcept(PREFIX, wanted.map(urlOf)).catch(() => {})
    await store.deletePagesExcept('http', wantedUrls).catch(() => {})
    if (done) global.logger.info(`[WEB]: Looked up ${done} topic(s)/page(s)`)
    return done
  } finally {
    running = false
  }
}

module.exports = { refresh, lookUp, readUrl, topics, urls, enabled, parts }
