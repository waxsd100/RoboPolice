// How many mentions the bot answers per day (Japan time), counted in Redis. Each mention is one
// count, however many Gemini calls it takes.
//
// In the owner's servers (priority.js) each user may have MENTION_DAILY_LIMIT a day (default 30).
// Elsewhere it is much tighter: MENTION_DAILY_LIMIT_OTHER per user (default 5) and
// MENTION_GUILD_DAILY_LIMIT_OTHER for the whole server (default 30). 0 turns a limit off.
const { isOwnerGuild } = require('./priority')

const DEFAULT_DAILY_LIMIT = 30
const DEFAULT_OTHER_USER_LIMIT = 5
const DEFAULT_OTHER_GUILD_LIMIT = 30
const TIMEZONE = 'Asia/Tokyo'
const TTL_SECONDS = 2 * 24 * 60 * 60 // a little past the day it counts

const store = {
  async increment (key, ttlSeconds) {
    const redis = require('../../db/clients/redis')
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, ttlSeconds)
    return count
  },
  async decrement (key) {
    const redis = require('../../db/clients/redis')
    await redis.decr(key)
  }
}

function limitOf (name, fallback) {
  const raw = process.env[name]
  const limit = Number(raw)
  return raw && Number.isInteger(limit) && limit >= 0 ? limit : fallback
}

function dailyLimit () {
  return limitOf('MENTION_DAILY_LIMIT', DEFAULT_DAILY_LIMIT)
}

// YYYY-MM-DD in Japan time.
function today (now) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TIMEZONE }).format(now)
}

// Counts one use by `userID` in `guildID`. Resolves to { allowed, limit, scope } where scope is
// 'user' or 'guild': which limit was reached. If Redis is unreachable the mention is let through:
// the limits are there to cap cost, not to take the bot down with Redis.
async function take (userID, guildID = null, now = new Date()) {
  const day = today(now)
  const owner = isOwnerGuild(guildID)
  const userLimit = owner ? dailyLimit() : limitOf('MENTION_DAILY_LIMIT_OTHER', DEFAULT_OTHER_USER_LIMIT)
  const guildLimit = owner ? 0 : limitOf('MENTION_GUILD_DAILY_LIMIT_OTHER', DEFAULT_OTHER_GUILD_LIMIT)
  try {
    const userKey = owner ? `mention-quota:${userID}:${day}` : `mention-quota:${guildID}:${userID}:${day}`
    if (userLimit) {
      const count = await store.increment(userKey, TTL_SECONDS)
      if (count > userLimit) return { allowed: false, limit: userLimit, scope: 'user' }
    }
    if (guildLimit) {
      const count = await store.increment(`mention-quota-guild:${guildID}:${day}`, TTL_SECONDS)
      if (count > guildLimit) {
        // Not answered, so it does not count against the user.
        if (userLimit) await store.decrement(userKey).catch(() => {})
        return { allowed: false, limit: guildLimit, scope: 'guild' }
      }
    }
    return { allowed: true, limit: userLimit, scope: 'user' }
  } catch (e) {
    global.logger.warn(`Mention quota check failed, letting it through: ${e.message}`)
    return { allowed: true, limit: userLimit, scope: 'user' }
  }
}

module.exports = { take, store, today, DEFAULT_DAILY_LIMIT, DEFAULT_OTHER_USER_LIMIT, DEFAULT_OTHER_GUILD_LIMIT }
