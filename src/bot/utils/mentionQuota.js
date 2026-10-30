// How many mentions each user may have the bot answer per day (Japan time), counted in Redis across
// every server. Each mention is one count, however many Gemini calls it takes. MENTION_DAILY_LIMIT
// overrides the default; 0 turns the limit off.
const DEFAULT_DAILY_LIMIT = 30
const TIMEZONE = 'Asia/Tokyo'
const TTL_SECONDS = 2 * 24 * 60 * 60 // a little past the day it counts

const store = {
  async increment (key, ttlSeconds) {
    const redis = require('../../db/clients/redis')
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, ttlSeconds)
    return count
  }
}

function dailyLimit () {
  const raw = process.env.MENTION_DAILY_LIMIT
  const limit = Number(raw)
  return raw && Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_DAILY_LIMIT
}

// YYYY-MM-DD in Japan time.
function today (now) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TIMEZONE }).format(now)
}

// Counts one use for `userID`. Resolves to { allowed, limit }. If Redis is unreachable the mention
// is let through: the limit is there to cap cost, not to take the bot down with Redis.
async function take (userID, now = new Date()) {
  const limit = dailyLimit()
  if (limit === 0) return { allowed: true, limit }
  try {
    const count = await store.increment(`mention-quota:${userID}:${today(now)}`, TTL_SECONDS)
    return { allowed: count <= limit, limit }
  } catch (e) {
    global.logger.warn(`Mention quota check failed, letting it through: ${e.message}`)
    return { allowed: true, limit }
  }
}

module.exports = { take, store, today, DEFAULT_DAILY_LIMIT }
