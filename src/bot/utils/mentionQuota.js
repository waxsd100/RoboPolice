// How much each user may use the mention assistant, like Claude's usage limits: counted in Gemini
// tokens, per user across every server, in two windows that start with the user's first use and
// reset when they run out: five hours (MENTION_TOKEN_LIMIT_5H, default 150,000) and a week
// (MENTION_TOKEN_LIMIT_WEEK, default 750,000), about what Claude's free plan allows (10 to 20
// ordinary exchanges in five hours). 0 turns one off. Counted in Redis.
//
// What a mention used is added once it is answered, so the mention that crosses a limit is still
// answered and the next is refused. Every Gemini call made for it counts (lookups, the stronger
// model, the rewrite), by what it cost on Gemini's price list (costOf): the limits are in tokens of
// the usual reply model's input ($0.75 a million), so 150,000 is about $0.11 and 750,000 about
// $0.56 of Gemini. The bot's developers (CREATOR_IDS) have no limit.
//
// A server can have no limits at all (%tokenlimit unlimited, guilds.token_unlimited): its members'
// use is still counted, but nothing there is refused or slowed down, and it has no daily cap.
//
// A server can have its own limits (%tokenlimit, guilds.token_limit_5h / token_limit_week): the
// user's use is still counted across every server, and measured against the limits of the server
// the mention is in.
//
// Before a limit is reached, use slows down instead: once a user has used MENTION_FLEX_AT_PERCENT
// (default 95) of either window, every Gemini call of their mentions goes to Flex inference (half
// the price, queued for up to minutes), like a speed limit. A server can set its own share
// (guilds.token_flex_at); 0 turns it off.
//
// Other servers than the owner's (priority.js) also have a cap for the whole server per day (Japan
// time): MENTION_GUILD_DAILY_LIMIT_OTHER mentions (default 30), 0 to turn it off.
//
// If Redis is unreachable the mention is let through: the limits are there to cap cost, not to
// take the bot down with Redis.
const { isOwnerGuild } = require('./priority')
const { isCreator } = require('./creatorIds')
const { usdOf } = require('./geminiPrices')

const WINDOWS = [
  { name: '5h', setting: 'MENTION_TOKEN_LIMIT_5H', fallback: 150000, seconds: 5 * 60 * 60, label: '5時間' },
  { name: 'week', setting: 'MENTION_TOKEN_LIMIT_WEEK', fallback: 750000, seconds: 7 * 24 * 60 * 60, label: '1週間' }
]
const DEFAULT_OTHER_GUILD_LIMIT = 30
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

// What one Gemini response used (its usageMetadata), as counted against the limits: what it cost
// (geminiPrices.js, from Gemini's price list) in tokens of the usual reply model's input at its
// price now ($0.75 per million), so a token of a dearer model, an answer token or an image counts
// for more, a cached prompt token or a cheaper model's for less, and Flex inference for half.
const UNIT_USD_PER_MILLION = 0.75
function costOf (meta, model, { flex = false, now = new Date() } = {}) {
  return usdOf(meta, model, { flex, now }) * 1e6 / UNIT_USD_PER_MILLION
}

const DEFAULT_FLEX_AT_PERCENT = 95

// The limit of window `w` in a server with `limits` ({ '5h', week, flexAt }: the server's own,
// null for the default).
function windowLimit (w, limits = {}) {
  const own = limits?.[w.name]
  return Number.isInteger(own) && own >= 0 ? own : limitOf(w.setting, w.fallback)
}

// The share (0..1) of a window at which mentions go to Flex; 0 for never.
function flexAt (limits = {}) {
  const own = limits?.flexAt
  const percent = Number.isInteger(own) && own >= 0 && own <= 100 ? own : Math.min(limitOf('MENTION_FLEX_AT_PERCENT', DEFAULT_FLEX_AT_PERCENT), 100)
  return percent / 100
}

// Whether `userID` may have a mention answered now, in a server with `limits` (its own, see
// windowLimit). Resolves to { allowed, flex } (flex: past the share where it slows down to Flex,
// with `window` and `used` as a share) or, when not, { allowed: false, scope: 'user', window: '5h' |
// 'week', label, limit, resetsAt } or { allowed: false, scope: 'guild', limit } for the server's
// daily cap.
async function take (userID, guildID = null, now = new Date(), { limits = {} } = {}) {
  // The bot's developers, and every member of a server with no limits (%tokenlimit unlimited).
  if (isCreator(userID) || limits?.unlimited === true) return { allowed: true, flex: false }
  try {
    const slowAt = flexAt(limits)
    let flex = false
    let slowWindow = null
    let used = 0
    for (const w of WINDOWS) {
      const limit = windowLimit(w, limits)
      if (!limit) continue
      const { value, resetsInMs } = await store.get(windowKey(userID, w), now)
      if (value >= limit) {
        return { allowed: false, scope: 'user', window: w.name, label: w.label, limit, resetsAt: new Date(now.getTime() + (resetsInMs ?? w.seconds * 1000)) }
      }
      if (slowAt && value >= limit * slowAt && value / limit > used) {
        flex = true
        slowWindow = w.name
        used = value / limit
      }
    }
    const guildLimit = isOwnerGuild(guildID) ? 0 : limitOf('MENTION_GUILD_DAILY_LIMIT_OTHER', DEFAULT_OTHER_GUILD_LIMIT)
    if (guildLimit) {
      const count = await store.increment(`mention-quota-guild:${guildID}:${today(now)}`, DAY_TTL_SECONDS)
      if (count > guildLimit) return { allowed: false, scope: 'guild', limit: guildLimit }
    }
    return flex ? { allowed: true, flex, window: slowWindow, used } : { allowed: true, flex: false }
  } catch (e) {
    global.logger.warn(`Mention quota check failed, letting it through: ${e.message}`)
    return { allowed: true, flex: false }
  }
}

// Counts what an answered mention used (the sum of costOf of its calls) against the user's limits.
async function record (userID, cost, now = new Date()) {
  const amount = Math.round(cost || 0)
  if (!amount || isCreator(userID)) return
  try {
    // Counted in every window, whatever this server's limits: another server may limit it.
    for (const w of WINDOWS) await store.add(windowKey(userID, w), amount, w.seconds, now)
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

module.exports = { windowLimit, flexAt, DEFAULT_FLEX_AT_PERCENT, take, record, refusal, costOf, UNIT_USD_PER_MILLION, store, today, WINDOWS, DEFAULT_OTHER_GUILD_LIMIT }
