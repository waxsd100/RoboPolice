const Redis = require('ioredis')

function positiveInt (name, fallback) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
  username: process.env.REDIS_USER || 'default',
  password: process.env.REDIS_PASSWORD,
  family: 0,
  // Bound stalled sockets so optional caches/quotas fail open instead of hanging mentions forever.
  connectTimeout: positiveInt('REDIS_CONNECT_TIMEOUT_MS', 5000),
  commandTimeout: positiveInt('REDIS_COMMAND_TIMEOUT_MS', 5000),
  maxRetriesPerRequest: positiveInt('REDIS_MAX_RETRIES_PER_REQUEST', 2)
})

let lastErrorLogAt = 0
redis.on('error', err => {
  const now = Date.now()
  if (now - lastErrorLogAt < 10000) return
  lastErrorLogAt = now
  const msg = `[REDIS]: Client error: ${err?.message || err}`
  if (global.logger?.warn) global.logger.warn(msg)
  else console.warn(msg)
})

module.exports = redis
