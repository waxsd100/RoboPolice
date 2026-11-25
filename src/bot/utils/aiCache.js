// Shared Redis cache for AI artifacts across workers and restarts: recent message embeddings
// (recentTopics.js), Gemini explicit context caches (eventDrafter.js), and resolved game store
// URLs (gameLinks.js).
//
// If Redis is unreachable, every read returns null/empty and every write is ignored, so a Redis
// outage never stops a reply or background task.
const store = {
  redis () {
    return require('../../db/clients/redis')
  },
  async get (key) {
    return this.redis().get(key)
  },
  async mget (keys) {
    if (!keys.length) return []
    return this.redis().mget(...keys)
  },
  async set (key, value, seconds) {
    await this.redis().set(key, value, 'EX', seconds)
  },
  async mset (entries, seconds) {
    if (!entries.length) return
    const multi = this.redis().multi()
    for (const [key, value] of entries) multi.set(key, value, 'EX', seconds)
    await multi.exec()
  },
  async setnx (key, value, seconds) {
    const res = await this.redis().set(key, value, 'EX', seconds, 'NX')
    return res === 'OK'
  },
  async del (key) {
    await this.redis().del(key)
  }
}

const DEFAULT_OP_TIMEOUT_MS = 3000

function opTimeoutMs () {
  const n = Number(process.env.REDIS_OP_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_OP_TIMEOUT_MS
}

function withTimeout (promise) {
  const ms = opTimeoutMs()
  let timer
  const timeout = new Promise((resolve, reject) => {
    // Keep the timer ref'd so the timeout still fires if nothing else holds the event loop;
    // finally() clears it as soon as the operation settles.
    timer = setTimeout(() => reject(new Error(`Redis operation timed out after ${ms}ms`)), ms)
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
}

async function get (key) {
  try {
    return (await withTimeout(store.get(key))) ?? null
  } catch (_) {
    return null
  }
}

async function getJson (key) {
  const raw = await get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (_) {
    return null
  }
}

async function mget (keys) {
  if (!keys.length) return []
  try {
    return (await withTimeout(store.mget(keys))).map(v => v ?? null)
  } catch (_) {
    return keys.map(() => null)
  }
}

async function set (key, value, seconds) {
  try {
    const res = await withTimeout(store.set(key, String(value), seconds))
    return res !== false
  } catch (_) {
    return false
  }
}

async function setJson (key, value, seconds) {
  return set(key, JSON.stringify(value), seconds)
}

async function mset (entries, seconds) {
  if (!entries.length) return
  try {
    await withTimeout(store.mset(entries, seconds))
  } catch (_) {}
}

async function setnx (key, value, seconds) {
  try {
    return await withTimeout(store.setnx(key, String(value), seconds))
  } catch (_) {
    return true
  }
}

async function del (key) {
  try {
    await withTimeout(store.del(key))
  } catch (_) {}
}

module.exports = { store, get, getJson, mget, set, setJson, mset, setnx, del }
