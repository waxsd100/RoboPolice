// How much each user may use the mention assistant, like Claude's usage limits: counted in Gemini
// tokens, per user across every server, in two windows that start with the user's first use and
// reset when they run out: five hours (MENTION_TOKEN_LIMIT_5H, default 300,000) and a week
// (MENTION_TOKEN_LIMIT_WEEK, default 2,000,000). 0 turns one off. Counted in Redis.
//
// What a mention used is added once it is answered, so the mention that crosses a limit is still
// answered and the next is refused. Every Gemini call made for it counts (lookups, the stronger
// model, the rewrite), weighted by what the model costs: a stronger model's tokens count for more,
// a lighter one's for less, and Flex inference (half the price) for half (weightOf). Prompt tokens
// read from Gemini's cache count at a tenth, as they are billed at a fraction. The bot's developers
// (CREATOR_IDS) have no limit.
//
// Other servers than the owner's (priority.js) also have a cap for the whole server per day (Japan
// time): MENTION_GUILD_DAILY_LIMIT_OTHER mentions (default 30), 0 to turn it off.
//
// If Redis is unreachable the mention is let through: the limits are there to cap cost, not to
// take the bot down with Redis.
const { isOwnerGuild } = require('./priority')
const { isCreator } = require('./creatorIds')

const WINDOWS = [
  { name: '5h', setting: 'MENTION_TOKEN_LIMIT_5H', fallback: 300000, seconds: 5 * 60 * 60, label: '5時間' },
  { name: 'week', setting: 'MENTION_TOKEN_LIMIT_WEEK', fallback: 2000000, seconds: 7 * 24 * 60 * 60, label: '1週間' }
]
const DEFAULT_OTHER_GUILD_LIMIT = 30
const CACHED_WEIGHT = 0.1
const TIMEZONE = 'Asia/Tokyo'
const DAY_TTL_SECONDS = 2 * 24 * 60 * 60 // a little past the day it counts

const store = {
  redis () {
    return require('../../db/clients/redis')
  },
  // Tokens used in a window and how long until it resets (ms; null when it has not started).
  async get (key) {
    const [[, value], [, ttl]] = await this.redis().multi().get(key).pttl(key).exec()
    return { value: Number(value) || 0, resetsInMs: ttl > 0 ? ttl : null }
  },
  // Adds to a window, starting it (with its length) if it has not started.
  async add (key, amount, seconds) {
    await this.redis().multi().set(key, 0, 'EX', seconds, 'NX').incrby(key, amount).exec()
  },
  async increment (key, ttlSeconds) {
    const count = await this.redis().incr(key)
    if (count === 1) await this.redis().expire(key, ttlSeconds)
    return count
  }
}

function limitOf (name, fallback) {
  const raw = process.env[name]
  const limit = Number(raw)
  return raw && Number.isInteger(limit) && limit >= 0 ? limit : fallback
}

const windowKey = (userID, w) => `mention-tokens:${w.name}:${userID}`

// YYYY-MM-DD in Japan time.
function today (now) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TIMEZONE }).format(now)
}

// How much a model's token counts, against the usual reply model's 1: MENTION_TOKEN_WEIGHTS
// ("gemini-4-argon=4,gemini-3.5-flash-lite=0.25", by exact name) for the models it names; else
// by kind: a Pro / Argon / Ultra model 4, a Lite one 0.25, any other 1. Flex inference halves it.
const DEFAULT_WEIGHTS = [[/argon|pro|ultra/i, 4], [/lite/i, 0.25]]
function configuredWeights () {
  const weights = new Map()
  for (const pair of String(process.env.MENTION_TOKEN_WEIGHTS || '').split(',')) {
    const [name, value] = pair.split('=').map(s => s?.trim())
    const n = Number(value)
    if (name && value && Number.isFinite(n) && n >= 0) weights.set(name, n)
  }
  return weights
}
function weightOf (model, { flex = false } = {}) {
  const name = String(model || '')
  const configured = configuredWeights()
  const weight = configured.has(name) ? configured.get(name) : (DEFAULT_WEIGHTS.find(([re]) => re.test(name))?.[1] ?? 1)
  return flex ? weight / 2 : weight
}

// The tokens one Gemini response used (its usageMetadata), as counted against the limits.
function costOf (meta, model, { flex = false } = {}) {
  if (!meta) return 0
  const prompt = meta.promptTokenCount || 0
  const cached = meta.cachedContentTokenCount || 0
  const tokens = prompt - cached + cached * CACHED_WEIGHT + (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0)
  return Math.max(0, tokens * weightOf(model, { flex }))
}

// Whether `userID` may have a mention answered now. Resolves to { allowed } or, when not,
// { allowed: false, scope: 'user', window: '5h' | 'week', label, limit, resetsAt } or
// { allowed: false, scope: 'guild', limit } for the server's daily cap.
async function take (userID, guildID = null, now = new Date()) {
  if (isCreator(userID)) return { allowed: true }
  try {
    for (const w of WINDOWS) {
      const limit = limitOf(w.setting, w.fallback)
      if (!limit) continue
      const { value, resetsInMs } = await store.get(windowKey(userID, w), now)
      if (value >= limit) {
        return { allowed: false, scope: 'user', window: w.name, label: w.label, limit, resetsAt: new Date(now.getTime() + (resetsInMs ?? w.seconds * 1000)) }
      }
    }
    const guildLimit = isOwnerGuild(guildID) ? 0 : limitOf('MENTION_GUILD_DAILY_LIMIT_OTHER', DEFAULT_OTHER_GUILD_LIMIT)
    if (guildLimit) {
      const count = await store.increment(`mention-quota-guild:${guildID}:${today(now)}`, DAY_TTL_SECONDS)
      if (count > guildLimit) return { allowed: false, scope: 'guild', limit: guildLimit }
    }
    return { allowed: true }
  } catch (e) {
    global.logger.warn(`Mention quota check failed, letting it through: ${e.message}`)
    return { allowed: true }
  }
}

// Counts what an answered mention used (the sum of costOf of its calls) against the user's limits.
async function record (userID, cost, now = new Date()) {
  const amount = Math.round(cost || 0)
  if (!amount || isCreator(userID)) return
  try {
    for (const w of WINDOWS) {
      if (limitOf(w.setting, w.fallback)) await store.add(windowKey(userID, w), amount, w.seconds, now)
    }
  } catch (e) {
    global.logger.warn(`Could not count a mention's tokens: ${e.message}`)
  }
}

// What the user is told when a limit is reached.
function refusal (quota, now = new Date()) {
  if (quota.scope === 'guild') {
    return `このサーバーの今日の利用回数の上限（1日${quota.limit}回）に達しました。明日（日本時間の0時以降）またお試しください。`
  }
  const sameDay = today(quota.resetsAt) === today(now)
  const at = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', ...(sameDay ? {} : { month: 'numeric', day: 'numeric' })
  }).format(quota.resetsAt)
  return `利用上限（${quota.label}あたり ${quota.limit.toLocaleString('en-US')} トークン）に達しました。${at}ごろ（日本時間）からまた使えます。`
}

module.exports = { take, record, refusal, costOf, weightOf, store, today, WINDOWS, DEFAULT_OTHER_GUILD_LIMIT }
