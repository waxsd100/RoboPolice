// What each server is like, so the mention assistant talks as one of its own: its running jokes,
// words and happenings, and how its members talk. Taken by Gemini out of the messages the bot
// already stores for the server's logs (so only servers with a message log), only in text and
// announcement channels everyone (@everyone) can read, and only the last SERVER_LORE_WEEKS weeks.
//
// Each channel's messages of a week are one chunk. A chunk is read again only when its messages
// changed (new, edited, deleted, or removed with /clearmydata), and chunks out of the window go, so
// what is kept follows what is stored. Nothing about a single member is kept: members are looked up
// only when someone asks about them (eventTools.js about_member).
//
// Off unless SERVER_LORE=true: it uses the stored log messages for something the Privacy Policy and
// the privileged intent answers do not declare yet. Update them before turning it on
// (docs/discord/privileged-intent-review.md).
//
// Every worker does the servers it hosts, each once a day.
const prompts = require('../utils/prompts')
const crypto = require('crypto')
const { embed, model } = require('../utils/embeddings')
const { isGatewayConfigured } = require('../utils/aiGateway')
const { callGemini, resolveTaskConfig } = require('./eventDrafter')
const { withoutCharCount } = require('../utils/textClean')
const { looksLikeInjection } = require('../utils/untrusted')
const { publicChannels } = require('./discordKnowledge')
const { fromStoredContent } = require('../../db/interfaces/postgres/create')
const store = require('../../db/interfaces/postgres/serverLore')

const DEFAULT_WEEKS = 8
const MIN_MESSAGES = 15 // a quieter week says little
const MAX_LINE = 300
const MAX_CHUNK_CHARS = 24000
const MAX_STYLE_LINES = 400
const STYLE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000
const MAX_EXTRACTIONS_PER_RUN = 20
const RUN_EVERY_MS = 24 * 60 * 60 * 1000
const CHECK_EVERY_MS = 60 * 60 * 1000
const FIRST_CHECK_MS = 5 * 60 * 1000
const EMBED_BATCH = 100
const MAX_FACTS = 20

const KINDS = ['joke', 'term', 'event', 'topic']
const KIND_LABELS = { joke: '身内ネタ', term: '用語・呼び名', event: '出来事', topic: 'よく話す話題' }

const hashOf = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)

function enabled () {
  return isGatewayConfigured() && process.env.SERVER_LORE === 'true'
}

function weeks () {
  const n = Number(process.env.SERVER_LORE_WEEKS)
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_WEEKS
}

// The Monday (Asia/Tokyo) of the week of `date`, as YYYY-MM-DD.
function weekOf (date) {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(date)
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

const timeOf = date => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)

// How a member is shown in the text Gemini reads; null for bots, whose messages are left out.
function nameOf (guild, userID) {
  const member = guild.members?.get(userID)
  const user = member?.user || global.bot.users?.get(userID)
  if (member?.bot || user?.bot || userID === global.bot.user.id) return null
  return member?.nick || user?.globalName || user?.username || 'メンバー'
}

function lineOf (guild, m) {
  const name = nameOf(guild, m.author_id)
  const text = fromStoredContent(m.content).replace(/\s+/g, ' ').trim()
  if (!name || !text) return null
  return `[${timeOf(new Date(m.ts))}] ${name}: ${text.slice(0, MAX_LINE)}`
}

// At most `max` characters of lines, spread evenly over all of them.
function fit (lines, max) {
  const total = lines.reduce((n, l) => n + l.length + 1, 0)
  if (total <= max) return lines
  const keep = Math.max(1, Math.floor(lines.length * max / total))
  return Array.from({ length: keep }, (_, i) => lines[Math.floor(i * lines.length / keep)])
}

// The server's chunks in the window: [{ channel, week, lines }], and every line, oldest first.
async function chunksOf (guild, now = new Date()) {
  const since = new Date(weekOf(new Date(now - (weeks() - 1) * 7 * 24 * 60 * 60 * 1000)) + 'T00:00:00+09:00')
  const chunks = []
  const all = []
  for (const channel of publicChannels(guild)) {
    const byWeek = new Map()
    for (const m of await store.channelMessages(guild.id, channel.id, since)) {
      const line = lineOf(guild, m)
      if (!line) continue
      const week = weekOf(new Date(m.ts))
      if (!byWeek.has(week)) byWeek.set(week, [])
      byWeek.get(week).push(line)
      all.push({ ts: new Date(m.ts), line: `#${channel.name} ${line}` })
    }
    for (const [week, lines] of byWeek) {
      if (lines.length >= MIN_MESSAGES) chunks.push({ channel, week, lines: fit(lines, MAX_CHUNK_CHARS) })
    }
  }
  return { chunks, lines: all.sort((a, b) => a.ts - b.ts).map(l => l.line) }
}

const FACT_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      kind: { type: 'STRING', enum: KINDS },
      name: { type: 'STRING' },
      content: { type: 'STRING' }
    },
    required: ['kind', 'name', 'content']
  }
}

async function generate (text, config, guildID = null) {
  const { model: m, thinking, flex } = await resolveTaskConfig('extract', guildID)
  const content = await callGemini(m, {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { ...config, ...thinking }
  }, { timeoutMs: 2 * 60 * 1000, purpose: 'serverLore', ...(flex ? { flex: true } : {}) })
  return content.parts.map(p => p.text || '').join('')
}

// What one chunk says about the server: [{ kind, name, content }].
async function extractFacts (chunk, guildID = null) {
  const raw = JSON.parse(await generate(
    prompts.render('lore/extract', { channel: chunk.channel.name, week: chunk.week, conversation: chunk.lines.join('\n') }),
    { temperature: 0, responseMimeType: 'application/json', responseSchema: FACT_SCHEMA },
    guildID) || '[]')
  return (Array.isArray(raw) ? raw : [])
    .filter(f => KINDS.includes(f?.kind) && String(f.name || '').trim() && String(f.content || '').trim())
    // Kept for every later reply: an instruction slipped into it would stay.
    .filter(f => !looksLikeInjection(`${f.name}\n${f.content}`))
    .slice(0, MAX_FACTS)
    .map(f => ({ kind: f.kind, name: String(f.name).trim().slice(0, 100), content: withoutCharCount(String(f.content).trim()).slice(0, 300) }))
}

async function describeStyle (lines, guildID = null) {
  return withoutCharCount((await generate(prompts.render('lore/style', { conversation: lines.join('\n') }), { temperature: 0.2 }, guildID)).trim()).slice(0, 1000)
}

// Brings the server's knowledge up to date with its stored messages. Resolves to { extracted, removed }.
async function refreshGuild (guild, { log = m => global.logger.warn(m), now = new Date() } = {}) {
  const { chunks, lines } = await chunksOf(guild, now)
  const known = await store.chunkHashes(guild.id)
  let extracted = 0
  for (const chunk of chunks) {
    const key = `${chunk.channel.id}|${chunk.week}`
    const hash = hashOf(chunk.lines.join('\n'))
    if (known[key] === hash) continue
    if (extracted >= MAX_EXTRACTIONS_PER_RUN) continue // the rest next time
    try {
      await store.saveChunk(guild.id, chunk.channel.id, chunk.week, hash, await extractFacts(chunk, guild.id))
      extracted++
    } catch (e) {
      // Text Gemini refuses would be refused again: kept with no knowledge until it changes.
      if (e.blocked) await store.saveChunk(guild.id, chunk.channel.id, chunk.week, hash, []).catch(() => {})
      else log(`[LORE]: Could not read #${chunk.channel.name} (${chunk.week}) in ${guild.id}: ${e.message}`)
    }
  }
  // Chunks out of the window, of channels no longer public, or that became too quiet.
  const removed = await store.deleteChunksExcept(guild.id, chunks.map(c => `${c.channel.id}|${c.week}`))

  const sample = lines.slice(-MAX_STYLE_LINES)
  if (sample.length < MIN_MESSAGES) {
    await store.deleteStyle(guild.id)
  } else {
    const style = await store.getStyle(guild.id)
    const hash = hashOf(sample.join('\n'))
    if (!style || (style.source_hash !== hash && now - new Date(style.updated_at) > STYLE_REFRESH_MS)) {
      try {
        await store.saveStyle(guild.id, await describeStyle(fit(sample, MAX_CHUNK_CHARS), guild.id), hash)
      } catch (e) {
        log(`[LORE]: Could not describe how ${guild.id} talks: ${e.message}`)
      }
    }
  }
  return { extracted, removed }
}

const factText = f => `${KIND_LABELS[f.kind]}: ${f.name}\n${f.content}`

async function embedPending () {
  const current = model()
  const guildIDs = global.bot?.guilds instanceof Map ? [...global.bot.guilds.keys()] : null
  let done = 0
  for (;;) {
    const batch = guildIDs !== null
      ? await store.factsToEmbed(current, EMBED_BATCH, guildIDs)
      : await store.factsToEmbed(current, EMBED_BATCH)
    if (batch.length === 0) return done
    const vectors = await embed(batch.map(factText))
    for (const [i, f] of batch.entries()) await store.saveFactEmbedding(f.id, vectors[i], current)
    done += batch.length
  }
}

// The servers this worker hosts, each once a day, one at a time.
const lastRun = new Map()
let running = false
async function runDue (now = Date.now()) {
  if (running || !enabled()) return
  running = true
  try {
    for (const guild of global.bot.guilds.values()) {
      if (now - (lastRun.get(guild.id) || 0) < RUN_EVERY_MS) continue
      lastRun.set(guild.id, now)
      const { extracted, removed } = await refreshGuild(guild).catch(e => {
        global.logger.warn(`[LORE]: Could not update ${guild.id}: ${e.message}`)
        return {}
      })
      if (extracted || removed) global.logger.info(`[LORE]: ${guild.id}: read ${extracted} chunk(s), dropped ${removed}`)
    }
    const embedded = await embedPending()
    if (embedded) global.logger.info(`[LORE]: Embedded ${embedded} piece(s) of server knowledge`)
  } catch (e) {
    global.logger.warn(`[LORE]: ${e.message}`)
  } finally {
    running = false
  }
}

function startServerLore () {
  if (!enabled()) return
  setTimeout(() => runDue(), FIRST_CHECK_MS)
  setInterval(() => runDue(), CHECK_EVERY_MS)
}

// What the server knows that is close to the request (`vectorOf()` resolves to its embedding, asked
// for only when the server has knowledge), drawn at random
// among the close ones like the community knowledge (wikiKnowledge.relatedKnowledge), and how its
// members talk. { facts: [line], style } for the server profile.
const MIN_RELATED_SCORE = 0.55
async function relatedLore (guildID, vectorOf, { limit = 5, random = Math.random } = {}) {
  if (!enabled()) return { facts: [], style: null }
  const style = await store.getStyle(guildID).catch(() => null)
  const vector = await store.hasFacts(guildID).catch(() => false) ? await vectorOf() : null
  const near = vector ? await store.nearestFacts(guildID, vector, model(), limit * 3).catch(() => []) : []
  const { weightedSample } = require('./wikiKnowledge')
  const close = near.filter(f => f.score >= MIN_RELATED_SCORE)
  const facts = weightedSample(close, limit, f => f.score - MIN_RELATED_SCORE + 0.05, random)
    .map(f => `- [${KIND_LABELS[f.kind]}] ${f.name}: ${f.content}（${f.week} の週）`)
  return { facts, style: style?.style || null }
}

module.exports = { startServerLore, runDue, refreshGuild, extractFacts, relatedLore, embedPending, enabled, weekOf, fit, KIND_LABELS }
