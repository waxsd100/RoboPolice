// The community's wiki as knowledge for the mention assistant: its characters, quotes and running
// jokes. WIKI_URLS (comma-separated top pages) names the wikis; each is read in full once a week
// (WIKI_REFRESH_HOURS), politely (one page every WIKI_DELAY_MS, only the /d/ pages its robots.txt
// allows) and split at its headings. Gemini then takes knowledge out of each part (characters,
// quotes, terms), done again only for parts that changed, and both the parts and the knowledge are
// embedded. The model searches it with search_wiki, and the emoji describer is told who the
// characters are.
//
// Runs on the worker owning shard 0, like the other jobs for every server.
const crypto = require('crypto')
const urlFetcher = require('../utils/urlFetcher')
const { parseWikiPage } = require('../utils/wikiPage')
const { embed, embedQuery, model } = require('../utils/embeddings')
const { isGatewayConfigured } = require('../utils/aiGateway')
const { callGemini, DEFAULT_GEMINI_MODEL } = require('./eventDrafter')
const { withoutCharCount } = require('../utils/textClean')
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

const KINDS = ['character', 'quote', 'term']
const KIND_LABELS = { character: 'キャラクター', quote: '名言・台詞', term: '用語・ネタ' }
const MAX_FACTS = 30

const EXTRACT_PROMPT = [
  'これは YouTuber についての文章（ファンが書いた wiki の一部、または本人の X のポスト）です。ここから知識を取り出して、JSON の配列で返してください。',
  '- character: 登場するキャラクター（配信者本人のキャラクター・ゲームのキャラクターなど）。name に名前、aliases に別名・読み・ローマ字表記、content に何者か・見た目の特徴（色・形・目立つ部分）・性格を書く。',
  '- quote: 名言・台詞・口ぐせ。name にその言葉をそのまま、content に誰がいつどんな場面で言ったか・どんな意味で使われるかを書く。',
  '- term: 用語・ネタ・コミュニティでよく使われる言葉。name に言葉、content に意味や由来を書く。',
  '本文に書かれていることだけを使い、推測で付け足さないでください。当てはまるものがなければ空の配列を返してください。',
  'content は1項目あたり短く（長くても200文字程度）。文字数は書かないでください。'
].join('\n')

const FACT_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      kind: { type: 'STRING', enum: KINDS },
      name: { type: 'STRING' },
      aliases: { type: 'ARRAY', items: { type: 'STRING' } },
      content: { type: 'STRING' }
    },
    required: ['kind', 'name', 'content']
  }
}

// The knowledge in one part: [{ kind, name, aliases, content }].
async function extractFacts (section) {
  const content = await callGemini(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, {
    contents: [{ role: 'user', parts: [{ text: `${EXTRACT_PROMPT}\n\nページ: ${section.title}\n見出し: ${section.heading}\n本文:\n${section.text}` }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: FACT_SCHEMA }
  }, { timeoutMs: 60 * 1000 })
  const raw = JSON.parse(content.parts.map(p => p.text || '').join('') || '[]')
  return (Array.isArray(raw) ? raw : [])
    .filter(f => KINDS.includes(f?.kind) && String(f.name || '').trim() && String(f.content || '').trim())
    .slice(0, MAX_FACTS)
    .map(f => ({
      kind: f.kind,
      name: String(f.name).trim().slice(0, 200),
      aliases: (Array.isArray(f.aliases) ? f.aliases : []).map(a => String(a).trim()).filter(Boolean).slice(0, 10),
      content: withoutCharCount(String(f.content).trim()).slice(0, 400)
    }))
}

// Takes knowledge out of the parts that changed. A part that fails is tried again next time.
// Resolves to how many parts were read.
async function extractPending ({ log = () => {} } = {}) {
  let done = 0
  // All at once, each tried once: a part that keeps failing must not hold up the rest.
  for (const section of await store.sectionsToExtract(MAX_PAGES * 20)) {
    try {
      await store.saveFacts(section.url, section.position, section.text_hash, await extractFacts(section))
      done++
    } catch (e) {
      log(`Could not take knowledge out of ${section.title} / ${section.heading}: ${e.message}`)
    }
  }
  return done
}

const factText = f => `${KIND_LABELS[f.kind]}: ${f.name}${f.aliases?.length ? `（${f.aliases.join('、')}）` : ''}\n${f.content}`

// Embeds the parts and the knowledge that have no embedding by the current model. Resolves to how many.
async function embedPending () {
  const current = model()
  let done = 0
  for (;;) {
    const batch = await store.sectionsToEmbed(current, EMBED_BATCH)
    if (batch.length === 0) break
    const vectors = await embed(batch.map(s => `${s.title} / ${s.heading}\n${s.text}`))
    for (const [i, s] of batch.entries()) await store.saveSectionEmbedding(s.url, s.position, vectors[i], current)
    done += batch.length
  }
  for (;;) {
    const batch = await store.factsToEmbed(current, EMBED_BATCH)
    if (batch.length === 0) return done
    const vectors = await embed(batch.map(factText))
    for (const [i, f] of batch.entries()) await store.saveFactEmbedding(f.id, vectors[i], current)
    done += batch.length
  }
}

// Takes knowledge out of, and embeds, whatever is new in the knowledge tables: wiki pages and X
// posts alike (twitterKnowledge.js stores posts as pages too). One at a time.
let processing = null
function processPending (log = m => global.logger.warn(m)) {
  if (!isGatewayConfigured()) return Promise.resolve(null)
  if (!processing) {
    processing = (async () => {
      const extracted = await extractPending({ log })
      if (extracted) global.logger.info(`[KNOWLEDGE]: Took knowledge out of ${extracted} part(s)`)
      const embedded = await embedPending()
      if (embedded) global.logger.info(`[KNOWLEDGE]: Embedded ${embedded} part(s) and piece(s) of knowledge`)
    })().finally(() => { processing = null })
  }
  return processing
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
    await processPending(m => global.logger.warn(`[WIKI]: ${m}`))
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

// Whether there is any knowledge to search: a wiki or X accounts are set.
function searchable () {
  return enabled() || require('./twitterKnowledge').enabled()
}

// What the wiki (and the X posts) know closest in meaning to `query`, as the search_wiki tool
// returns it: the knowledge taken out first, then the parts of pages and posts themselves.
async function searchWiki (query, { facts = 8, sections = 3 } = {}) {
  if (!searchable()) return 'wiki は設定されていません'
  if (!await store.hasSections()) return 'wiki はまだ読み込まれていません（しばらくすると読み込まれます）'
  const q = await embedQuery(query)
  const [knowledge, parts] = await Promise.all([store.nearestFacts(q, model(), facts), store.nearestSections(q, model(), sections)])
  if (!knowledge.length && !parts.length) return `wiki に「${query}」に近い記述は見つかりませんでした`
  const lines = [`wiki で「${query}」に意味が近いもの（近い順）:`]
  if (knowledge.length) {
    lines.push('', '知識:', ...knowledge.map(f => `- [${KIND_LABELS[f.kind]}] ${f.name}${f.aliases?.length ? `（${f.aliases.join('、')}）` : ''}: ${f.content}（${f.title} / ${f.heading}）`))
  }
  if (parts.length) {
    lines.push('', '本文:', ...parts.map(s => `- ${s.title} / ${s.heading}（${s.url}）\n${s.text.slice(0, MAX_RESULT_TEXT)}${s.text.length > MAX_RESULT_TEXT ? '…' : ''}`))
  }
  return lines.join('\n')
}

// Who the wiki's characters are, for describing emojis: { text, hash }, text empty when unknown.
// The characters taken out as knowledge (with other names and looks) when there are any, else the
// parts of the pages about characters.
async function characterContext () {
  if (!searchable()) return { text: '', hash: null }
  const known = await store.characterFacts().catch(() => [])
  const rows = known.length
    ? known.map(c => ({ heading: `${c.name}${c.aliases?.length ? `（${c.aliases.join('、')}）` : ''}`, text: c.content }))
    : await store.characters().catch(() => [])
  const text = rows.map(r => `- ${r.heading}: ${r.text.replace(/\s+/g, ' ').slice(0, 150)}`).join('\n').slice(0, 8000)
  return { text, hash: text ? crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) : null }
}

module.exports = { startWiki, refresh, crawl, extractFacts, extractPending, embedPending, processPending, searchWiki, characterContext, enabled, searchable, wikiRoots }
