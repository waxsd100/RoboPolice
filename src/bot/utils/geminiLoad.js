// How busy the bot is with Gemini as a whole: what every call cost in the past hour (in the same
// tokens as the user limits, mentionQuota.costOf), against GEMINI_HOURLY_BUDGET (default 2,000,000,
// about $1.50 an hour), across every worker (Redis). The busier it is, the less is spent on each
// call:
//
//   below GEMINI_LOAD_MEDIUM_AT (default 50%)  as set
//   from it                                    mention replies think at medium at most
//   from GEMINI_LOAD_FLEX_AT (default 80%)     they think at low, and every generation, the
//                                              replies and everything done in the background, goes
//                                              to Flex inference (half the price, queued)
//
// The past hour is two hour-long buckets, the last one counted for the part of it still in the
// window. The level is read again at most every LEVEL_TTL_MS and kept, so a call never waits for
// Redis; GEMINI_HOURLY_BUDGET=0 turns all of this off. If Redis is unreachable nothing changes.
const BUCKET_MS = 60 * 60 * 1000
const LEVEL_TTL_MS = 30 * 1000
const DEFAULT_BUDGET = 2000000
const DEFAULT_MEDIUM_AT = 50
const DEFAULT_FLEX_AT = 80

const store = {
  redis () {
    return require('../../db/clients/redis')
  },
  async add (key, amount, seconds) {
    await this.redis().multi().incrby(key, amount).expire(key, seconds).exec()
  },
  async get (keys) {
    return (await this.redis().mget(...keys)).map(v => Number(v) || 0)
  }
}

function setting (name, fallback) {
  const raw = process.env[name]
  const n = Number(raw)
  return raw && Number.isFinite(n) && n >= 0 ? n : fallback
}

const budget = () => setting('GEMINI_HOURLY_BUDGET', DEFAULT_BUDGET)
const bucketOf = now => Math.floor(now / BUCKET_MS)
const keyOf = bucket => `gemini-load:${bucket}`

// What was spent in the past hour, by the buckets' counts.
function spent ([current, previous], now) {
  const intoBucket = (now % BUCKET_MS) / BUCKET_MS
  return current + previous * (1 - intoBucket)
}

// 0: as set; 1: medium thinking; 2: low thinking and Flex for everything.
function levelOf (share) {
  if (share >= setting('GEMINI_LOAD_FLEX_AT', DEFAULT_FLEX_AT) / 100) return 2
  if (share >= setting('GEMINI_LOAD_MEDIUM_AT', DEFAULT_MEDIUM_AT) / 100) return 1
  return 0
}

let known = { level: 0, share: 0, at: -Infinity }
let reading = null

// Reads the level again (when it is older than LEVEL_TTL_MS). Resolves to { level, share }.
async function refresh (now = Date.now()) {
  if (!budget()) {
    known = { level: 0, share: 0, at: now }
    return known
  }
  if (now - known.at < LEVEL_TTL_MS) return known
  if (!reading) {
    reading = (async () => {
      try {
        const bucket = bucketOf(now)
        const share = spent(await store.get([keyOf(bucket), keyOf(bucket - 1)]), now) / budget()
        const level = levelOf(share)
        if (level !== known.level) global.logger?.info(`[GEMINI]: Load ${Math.round(share * 100)}% of GEMINI_HOURLY_BUDGET: level ${level}`)
        known = { level, share, at: now }
      } catch (e) {
        known = { ...known, at: now } // tried: not again at once
      } finally {
        reading = null
      }
      return known
    })()
  }
  return reading
}

// The level as last read, without waiting (and reads it again in the background when old).
function current (now = Date.now()) {
  if (now - known.at >= LEVEL_TTL_MS) refresh(now).catch(() => {})
  return budget() ? known : { level: 0, share: 0 }
}

// Counts what a call cost.
function record (cost, now = Date.now()) {
  const amount = Math.round(cost || 0)
  if (!amount || !budget()) return
  store.add(keyOf(bucketOf(now)), amount, 3 * 60 * 60).catch(() => {})
}

// The thinking level a mention reply may use at the current load, given the one it is set to.
const ORDER = ['minimal', 'low', 'medium', 'high']
function cappedThinking (level, load = current().level) {
  const cap = load >= 2 ? 'low' : load >= 1 ? 'medium' : null
  if (!cap || !ORDER.includes(level)) return level
  return ORDER.indexOf(level) > ORDER.indexOf(cap) ? cap : level
}

// Whether every generation goes to Flex now.
function flexForAll () {
  return current().level >= 2
}

// For tests: forget what was read.
function reset () {
  known = { level: 0, share: 0, at: -Infinity }
  reading = null
}

module.exports = { store, refresh, current, record, cappedThinking, flexForAll, levelOf, spent, reset, BUCKET_MS }
