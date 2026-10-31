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
const xStore = require('../../db/interfaces/postgres/xKnowledge')
const discordStore = require('../../db/interfaces/postgres/discordKnowledge')

// The knowledge tables: the wiki's, the X posts' (twitterKnowledge.js) and the streamer's Discord
// messages' (discordKnowledge.js), worked on alike.
const stores = () => [store, xStore, discordStore]

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
  'これは YouTuber についての文章（ファンが書いた wiki の一部、または本人の X のポストや Discord での発言）です。ここから知識を取り出して、JSON の配列で返してください。',
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
  for (const tables of stores()) {
    // All at once, each tried once: a part that keeps failing must not hold up the rest.
    for (const section of await tables.sectionsToExtract(MAX_PAGES * 20)) {
      try {
        await tables.saveFacts(section.url, section.position, section.text_hash, await extractFacts(section))
        done++
      } catch (e) {
        if (e.blocked) {
          // Google refuses this text (e.g. PROHIBITED_CONTENT) and would again: it is marked done with
          // no knowledge, not sent again until it changes. Its text is still embedded and searchable.
          await tables.saveFacts(section.url, section.position, section.text_hash, [])
            .then(() => global.logger.info(`[KNOWLEDGE]: Skipped ${section.title} / ${section.heading}: Gemini blocked it (${e.blocked})`))
            .catch(err => log(`Could not mark ${section.title} / ${section.heading} as skipped: ${err.message}`))
        } else {
          log(`Could not take knowledge out of ${section.title} / ${section.heading}: ${e.message}`)
        }
      }
    }
  }
  return done
}

const factText = f => `${KIND_LABELS[f.kind]}: ${f.name}${f.aliases?.length ? `（${f.aliases.join('、')}）` : ''}\n${f.content}`

// Embeds the parts and the knowledge that have no embedding by the current model. Resolves to how many.
async function embedPending () {
  const current = model()
  let done = 0
  for (const tables of stores()) {
    for (;;) {
      const batch = await tables.sectionsToEmbed(current, EMBED_BATCH)
      if (batch.length === 0) break
      const vectors = await embed(batch.map(s => `${s.title} / ${s.heading}\n${s.text}`))
      for (const [i, s] of batch.entries()) await tables.saveSectionEmbedding(s.url, s.position, vectors[i], current)
      done += batch.length
    }
    for (;;) {
      const batch = await tables.factsToEmbed(current, EMBED_BATCH)
      if (batch.length === 0) break
      const vectors = await embed(batch.map(factText))
      for (const [i, f] of batch.entries()) await tables.saveFactEmbedding(f.id, vectors[i], current)
      done += batch.length
    }
  }
  return done
}

// Takes knowledge out of, and embeds, whatever is new in the knowledge tables: the wiki's and the
// X posts' alike. One at a time.
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
  if (running || !searchable()) return null
  running = true
  try {
    const maxAge = setting('WIKI_REFRESH_HOURS', DEFAULT_REFRESH_HOURS) * 3600 * 1000
    // Without WIKI_URLS there is no wiki to read, but the X posts and Discord messages still get
    // their knowledge taken out below.
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
  if (!searchable()) return null
  if (enabled()) global.logger.startup(`[WIKI]: Reading ${wikiRoots().map(r => r.origin).join(', ')} as knowledge.`)
  refresh()
  return setInterval(() => refresh(), CHECK_EVERY_MS)
}

// Whether there is any knowledge to search: a wiki, X accounts or Discord accounts are set.
function searchable () {
  return enabled() || require('./twitterKnowledge').enabled() || require('./discordKnowledge').enabled()
}

// What the wiki (and the X posts) know closest in meaning to `query`, as the search_wiki tool
// returns it: the knowledge taken out first, then the parts of pages and posts themselves.
async function searchWiki (query, { facts = 8, sections = 3 } = {}) {
  if (!searchable()) return 'wiki は設定されていません'
  const filled = await Promise.all(stores().map(t => t.hasSections()))
  if (!filled.some(Boolean)) return 'wiki はまだ読み込まれていません（しばらくすると読み込まれます）'
  const q = await embedQuery(query)
  // The closest of the wiki's and of the X posts' together.
  const closest = async (find, limit) => (await Promise.all(stores().filter((_, i) => filled[i]).map(t => find(t, limit))))
    .flat().sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit)
  const [knowledge, parts] = await Promise.all([
    closest((t, n) => t.nearestFacts(q, model(), n), facts),
    closest((t, n) => t.nearestSections(q, model(), n), sections)
  ])
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

// What the knowledge says about the request, for the server's profile sent with every request, so
// the model knows the community's characters and words without having to search first:
// characters named in the request (by name or other name), then the knowledge closest in meaning
// to it (`vector`, its embedding). Lines; none when there is no knowledge or nothing near.
const MIN_RELATED_SCORE = 0.55
async function relatedKnowledge (query, vector, { limit = 6 } = {}) {
  if (!searchable() || !String(query || '').trim()) return []
  const text = String(query)
  const named = (await store.characterFacts().catch(() => []))
    .filter(c => [c.name, ...(c.aliases || [])].some(n => n && n.length >= 2 && text.includes(n)))
    .map(c => ({ kind: 'character', ...c }))
  const near = vector
    ? (await Promise.all(stores().map(t => t.nearestFacts(vector, model(), limit).catch(() => []))))
        .flat().filter(f => (f.score ?? 0) >= MIN_RELATED_SCORE).sort((a, b) => b.score - a.score)
    : []
  const seen = new Set()
  return [...named, ...near]
    .filter(f => !seen.has(`${f.kind}:${f.name}`) && seen.add(`${f.kind}:${f.name}`))
    .slice(0, limit)
    .map(f => `- [${KIND_LABELS[f.kind]}] ${f.name}${f.aliases?.length ? `（${f.aliases.join('、')}）` : ''}: ${f.content}`)
}

// Who the wiki's characters are, for describing emojis: { text, hash }, text empty when unknown.
// The characters taken out as knowledge (with other names and looks) when there are any, else the
// parts of the pages about characters. The wiki's only, not the X posts': those change daily, and
// every emoji would be described again each time.
//
// Also: names, each character's name and other names (an emoji named after one is that one), and
// images, a picture of each character the wiki has one of ({ name, url }), shown to Gemini so it
// can tell which character an emoji is from how it looks. The hash covers all of it.
async function characterContext () {
  if (!searchable()) return { text: '', hash: null, names: [], images: [] }
  const known = await store.characterFacts().catch(() => [])
  const rows = known.length
    ? known.map(c => ({ heading: `${c.name}${c.aliases?.length ? `（${c.aliases.join('、')}）` : ''}`, text: c.content }))
    : await store.characters().catch(() => [])
  const text = rows.map(r => `- ${r.heading}: ${r.text.replace(/\s+/g, ' ').slice(0, 150)}`).join('\n').slice(0, 8000)
  const names = known.length
    ? known.map(c => ({ name: c.name, aliases: c.aliases || [] }))
    : rows.map(r => ({ name: r.heading, aliases: [] }))
  const images = (await store.characterImages().catch(() => [])).map(r => ({ name: r.heading, url: r.image }))
  const hashed = text + images.map(i => `\n${i.name} ${i.url}`).join('')
  return { text, hash: text ? crypto.createHash('sha256').update(hashed).digest('hex').slice(0, 16) : null, names, images }
}

module.exports = { startWiki, refresh, crawl, extractFacts, extractPending, embedPending, processPending, searchWiki, relatedKnowledge, characterContext, enabled, searchable, wikiRoots }
