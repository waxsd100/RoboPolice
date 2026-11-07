// What was being talked about in the channel just before a mention, as far as it bears on what is
// asked: of the last MENTION_RECENT_MESSAGES messages (default 50) of the past MENTION_RECENT_HOURS
// (default 12), those closest in meaning to the request (at most MAX_TOPICS, none below
// MIN_SCORE), in the order they were said. A question like "それってどうなの？" or "さっきの話だけど"
// is then answered with the talk it is about, and a request that has nothing to do with it gets
// nothing.
//
// Read from Discord as the mention comes in and embedded on the spot (one call for the request, one
// for the messages; embeddings cost little). The bot's own and other bots' messages, commands and
// noise (messageNoise.js) are left out, so the bot does not carry on from what it said itself.
// MENTION_RECENT_TOPICS=false turns it off.
const { embed, embedQuery, model, similarity } = require('../utils/embeddings')
const { embeddableText } = require('../utils/messageNoise')

const DEFAULT_MESSAGES = 50
const DEFAULT_HOURS = 12
const MAX_TOPICS = 8
const MIN_SCORE = 0.55
const MAX_CHARS = 200
const MAX_CACHE = 2000

// Recent messages in a busy channel are read on every mention; keeping their vectors in memory means
// each message is embedded at most once instead of again on every turn of a conversation.
const vectorCache = new Map() // `${model}\n${text}` -> Int8Array

function cachedVector (key) {
  const v = vectorCache.get(key)
  if (!v) return null
  vectorCache.delete(key)
  vectorCache.set(key, v)
  return v
}

function rememberVector (key, vector) {
  if (vectorCache.has(key)) vectorCache.delete(key)
  else if (vectorCache.size >= MAX_CACHE) vectorCache.delete(vectorCache.keys().next().value)
  vectorCache.set(key, vector)
}

function clearCache () {
  vectorCache.clear()
}

function enabled () {
  return process.env.MENTION_RECENT_TOPICS !== 'false'
}

function setting (name, fallback, max = Infinity) {
  const n = Number(process.env[name])
  return process.env[name] && Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback
}

const displayName = m => m?.nick || m?.user?.globalName || m?.globalName || m?.username || m?.user?.username

// Lines for the prompt ("- [HH:MM] 名前: 本文"), oldest first; [] when there is nothing related.
// `message` is the mention; `request` what it asks (without the mention).
async function relatedRecent (message, request, {
  now = Date.now(),
  getMessages = (id, options) => global.bot.getMessages(id, options)
} = {}) {
  if (!enabled() || !embeddableText(request)) return []
  const since = now - setting('MENTION_RECENT_HOURS', DEFAULT_HOURS) * 60 * 60 * 1000
  const page = await getMessages(message.channel.id, { limit: setting('MENTION_RECENT_MESSAGES', DEFAULT_MESSAGES, 100), before: message.id })
  const candidates = page
    .filter(m => m && !m.author?.bot && m.timestamp >= since)
    .map(m => ({ m, text: embeddableText(m.content) }))
    .filter(c => c.text)
  if (!candidates.length) return []
  const currentModel = model()
  const missingKeys = []
  const missingTexts = []
  const seenMissing = new Set()
  for (const c of candidates) {
    const key = `${currentModel}\n${c.text}`
    if (!cachedVector(key) && !seenMissing.has(key)) {
      seenMissing.add(key)
      missingKeys.push(key)
      missingTexts.push(c.text)
    }
  }
  const [query, fresh] = await Promise.all([
    embedQuery(request),
    missingTexts.length ? embed(missingTexts) : Promise.resolve([])
  ])
  for (let i = 0; i < missingKeys.length; i++) rememberVector(missingKeys[i], fresh[i])
  const vectors = candidates.map(c => cachedVector(`${currentModel}\n${c.text}`))
  const guild = message.channel.guild
  return candidates
    .map((c, i) => ({ ...c, score: similarity(query, vectors[i]) }))
    .filter(c => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TOPICS)
    .sort((a, b) => a.m.timestamp - b.m.timestamp)
    .map(({ m }) => {
      const at = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }).format(new Date(m.timestamp))
      const who = displayName(guild?.members?.get(m.author.id)) || displayName(m.member) || displayName(m.author) || m.author.id
      const text = String(m.content).replace(/\s+/g, ' ').trim()
      return `- [${at}] ${who}（<@${m.author.id}>）: ${text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text}`
    })
}

module.exports = { relatedRecent, clearCache, enabled, MIN_SCORE, MAX_TOPICS }
