// Fills channel_id and guild_id of messages stored before they were recorded. Discord
// cannot say which channel a message ID is in, so this reads the history of every channel and
// thread of each server back to the oldest such message (100 messages a request) and matches IDs.
// Messages no longer on Discord stay as they are.
//
// The bot runs it once in the background (startBackfill, from the shard 0 worker), slowly so its
// own requests keep their share of the rate limit, and records in Redis that it is done.
// BACKFILL_CHANNELS=false turns that off. By hand: node src/miscellaneous/backfillChannels.js
// (npm run backfill-channels). Safe to stop and run again: it only touches rows whose channel is
// still unknown.
const DISCORD_EPOCH = 1420070400000n
const API = 'https://discord.com/api/v10'
// Channel types whose messages can be read: text, voice, announcement, stage, and threads.
const WITH_MESSAGES = new Set([0, 2, 5, 13, 10, 11, 12])
// Channel types that hold threads: text, announcement, forum, media.
const WITH_THREADS = new Set([0, 5, 15, 16])

const snowflakeAt = date => ((BigInt(new Date(date).getTime()) - DISCORD_EPOCH) << 22n).toString()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// GET from Discord, waiting out rate limits. Resolves to the JSON, or null for a channel the bot
// cannot read (403) or that is gone (404).
// pace: milliseconds to wait before each request.
function discordClient ({ token, fetchImpl = fetch, wait = sleep, pace = 0 }) {
  return async function get (path) {
    if (pace) await wait(pace)
    for (;;) {
      const res = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bot ${token}` } })
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}))
        await wait(Math.ceil((body.retry_after || 1) * 1000))
        continue
      }
      if (res.status === 403 || res.status === 404) return null
      if (!res.ok) throw new Error(`Discord ${path}: HTTP ${res.status}`)
      if (res.headers.get('x-ratelimit-remaining') === '0') await wait(Math.ceil(Number(res.headers.get('x-ratelimit-reset-after') || 1) * 1000))
      return res.json()
    }
  }
}

// Every channel and thread of the server that can hold messages newer than `since`.
async function channelsOf (get, guildID, since) {
  const channels = (await get(`/guilds/${guildID}/channels`)) || []
  const threads = ((await get(`/guilds/${guildID}/threads/active`)) || {}).threads || []
  for (const parent of channels.filter(c => WITH_THREADS.has(c.type))) {
    for (const kind of ['public', 'private']) {
      let before = null
      for (;;) {
        const page = await get(`/channels/${parent.id}/threads/archived/${kind}?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`)
        if (!page?.threads?.length) break
        // Newest archived first: older ones were archived before `since` and hold nothing newer.
        const recent = page.threads.filter(t => new Date(t.thread_metadata.archive_timestamp) >= new Date(since))
        threads.push(...recent)
        if (!page.has_more || recent.length < page.threads.length) break
        before = page.threads[page.threads.length - 1].thread_metadata.archive_timestamp
      }
    }
  }
  const seen = new Set()
  return [...channels, ...threads].filter(c => WITH_MESSAGES.has(c.type) && !seen.has(c.id) && seen.add(c.id))
}

// Pages of message IDs in the channel, newest first, down to `oldestID`.
async function * messageIdPages (get, channelID, oldestID) {
  let before = null
  for (;;) {
    const page = await get(`/channels/${channelID}/messages?limit=100${before ? `&before=${before}` : ''}`)
    if (!page?.length) return
    yield page.map(m => m.id)
    before = page[page.length - 1].id
    if (BigInt(before) < BigInt(oldestID) || page.length < 100) return
  }
}

// Resolves to { filled, remaining }.
async function backfill ({ pool, get, log = () => {} }) {
  const pending = new Set((await pool.query('SELECT id FROM messages WHERE channel_id IS NULL')).rows.map(r => r.id))
  if (pending.size === 0) return { filled: 0, remaining: 0 }
  const oldest = (await pool.query('SELECT min(ts) AS ts FROM messages WHERE channel_id IS NULL')).rows[0].ts
  // A little before the oldest stored time: a message is stored when the bot sees it, just after it is sent.
  const since = new Date(new Date(oldest).getTime() - 60 * 60 * 1000)
  const oldestID = snowflakeAt(since)
  let filled = 0
  for (const { id: guildID } of (await pool.query('SELECT id FROM guilds')).rows) {
    for (const channel of await channelsOf(get, guildID, since)) {
      let inChannel = 0
      for await (const ids of messageIdPages(get, channel.id, oldestID)) {
        const found = ids.filter(id => pending.has(id))
        if (found.length === 0) continue
        // Embedding skipped them for having no channel; now they can be embedded.
        await pool.query('UPDATE messages SET channel_id = $1, guild_id = $2, embedded = false WHERE id = ANY($3) AND channel_id IS NULL', [channel.id, guildID, found])
        for (const id of found) pending.delete(id)
        inChannel += found.length
        if (pending.size === 0) break
      }
      if (inChannel) log(`${channel.name || channel.id}: ${inChannel}`)
      filled += inChannel
      if (pending.size === 0) return { filled, remaining: 0 }
    }
  }
  return { filled, remaining: pending.size }
}

const DONE_KEY = 'backfill-channels:done'
const PACE_MS = 250

// Runs the backfill once in the background, unless it has finished before or is turned off.
// Resolves when it ends (the bot does not wait for it).
async function startBackfill ({ pool = require('../db/clients/postgres'), redis = global.redis, get = discordClient({ token: process.env.BOT_TOKEN, pace: PACE_MS }), log = global.logger } = {}) {
  if (process.env.BACKFILL_CHANNELS === 'false') return null
  try {
    if (await redis.get(DONE_KEY)) return null
    const pending = (await pool.query('SELECT count(*)::int AS n FROM messages WHERE channel_id IS NULL')).rows[0].n
    if (pending === 0) {
      await redis.set(DONE_KEY, new Date().toISOString())
      return null
    }
    log.startup(`[BACKFILL]: Finding the channel of ${pending.toLocaleString()} message(s) stored before channels were recorded, in the background.`)
    const result = await backfill({ pool, get, log: m => log.info(`[BACKFILL]: ${m}`) })
    await redis.set(DONE_KEY, new Date().toISOString())
    log.info(`[BACKFILL]: Filled the channel of ${result.filled.toLocaleString()} message(s); ${result.remaining.toLocaleString()} are no longer on Discord and stay unknown.`)
    return result
  } catch (e) {
    // Tried again at the next start.
    log.warn(`[BACKFILL]: Stopped: ${e.message}`)
    return null
  }
}

module.exports = { backfill, startBackfill, channelsOf, messageIdPages, discordClient, snowflakeAt, DONE_KEY }

if (require.main === module) {
  require('dotenv').config()
  require('./secrets').loadSecrets().then(async () => {
    const pool = require('../db/clients/postgres')
    const { filled, remaining } = await backfill({ pool, get: discordClient({ token: process.env.BOT_TOKEN }), log: m => console.log(`[BACKFILL]: ${m}`) })
    console.log(`[BACKFILL]: Filled the channel of ${filled.toLocaleString()} message(s); ${remaining.toLocaleString()} are no longer on Discord and stay unknown.`)
    pool.end()
    process.exit(0)
  }).catch(e => {
    console.error(`[BACKFILL]: ${e.message}`)
    process.exit(1)
  })
}
