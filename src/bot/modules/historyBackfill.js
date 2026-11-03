// Messages sent before the bot stored them: before it joined the server, before the server set a
// message log, or in channels quiet since. Live messages are stored as they arrive
// (events/messageCreate.js); this reads each channel's history back and stores what is missing,
// under the same rules: only servers with a message deletion or edit log, not ignored channels, not
// bots, not automod notices.
//
// How far back, whichever comes first:
// - a date: HISTORY_BACKFILL_SINCE (YYYY-MM-DD, Asia/Tokyo), and/or a number of days:
//   HISTORY_BACKFILL_DAYS (0 for no limit). With neither, everything.
//   Never further than MESSAGE_HISTORY_DAYS: older ones would be pruned at once.
// - a number of messages per channel: HISTORY_BACKFILL_MAX_MESSAGES (unset or 0 for no limit).
// A channel that stopped at the limits is read on from where it stopped when they are widened later
// (an earlier date, more days or more messages); one read to its start is not read again.
// 100 messages a request, one request every
// HISTORY_BACKFILL_DELAY_MS; where each channel got to is kept (message_backfill), so a restart goes
// on from there. Every worker does the servers it hosts, checking hourly for new channels and
// servers that turned a message log on. HISTORY_BACKFILL=false turns it off.
const { toStoredContent } = require('../../db/interfaces/postgres/create')
const store = require('../../db/interfaces/postgres/messageHistory')
const cacheGuild = require('../utils/cacheGuild')

const PAGE_SIZE = 100
const DEFAULT_DELAY_MS = 1000
const MAX_IMAGES = 10
const FIRST_RUN_MS = 2 * 60 * 1000
const RUN_EVERY_MS = 60 * 60 * 1000
// Text, voice (its text chat), announcement, stage, and threads.
const CHANNEL_TYPES = [0, 2, 5, 10, 11, 12, 13]
const SKIPPED_MESSAGE_TYPES = [23, 24] // automod

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function enabled () {
  return process.env.HISTORY_BACKFILL !== 'false'
}

function setting (name) {
  const n = Number(process.env[name])
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(n) && n >= 0 ? n : null
}

const DAY_MS = 24 * 60 * 60 * 1000

// HISTORY_BACKFILL_SINCE as a time (the start of that day in Asia/Tokyo), or null.
function sinceDate () {
  const raw = String(process.env.HISTORY_BACKFILL_SINCE || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const t = Date.parse(`${raw}T00:00:00+09:00`)
  return Number.isFinite(t) ? t : null
}

// The oldest time to read back to (ms), or -Infinity for no limit.
function startOf (now = Date.now()) {
  const limits = []
  const since = sinceDate()
  if (since !== null) limits.push(since)
  const days = setting('HISTORY_BACKFILL_DAYS')
  if (days) limits.push(now - days * DAY_MS)
  const retention = setting('MESSAGE_HISTORY_DAYS')
  if (retention) limits.push(now - retention * DAY_MS)
  return limits.length ? Math.max(...limits) : -Infinity
}

// How many messages of a channel to read back at most; null for no limit.
function maxMessages () {
  return setting('HISTORY_BACKFILL_MAX_MESSAGES') || null
}

function delay () {
  return setting('HISTORY_BACKFILL_DELAY_MS') ?? DEFAULT_DELAY_MS
}

// The channels whose history is read: those the bot can read back, not ignored by the server.
function channelsOf (guild, settings) {
  const threads = guild.threads ? [...guild.threads.values()] : []
  return [...guild.channels.values(), ...threads].filter(c => CHANNEL_TYPES.includes(c.type) &&
    !settings.isChannelIgnored(c.id) &&
    c.permissionsOf(global.bot.user.id).has('viewChannel') && c.permissionsOf(global.bot.user.id).has('readMessageHistory'))
}

// A message as stored, or null for one that is not (bots, automod notices).
function toRow (message, guild, channel) {
  if (SKIPPED_MESSAGE_TYPES.includes(message.type) || message.author?.bot || message.author?.id === global.bot.user.id) return null
  const imageUrls = [...new Set((message.attachments || []).filter(a => a.content_type?.startsWith('image')).map(a => a.url))].slice(0, MAX_IMAGES)
  return {
    id: message.id,
    authorID: message.author.id,
    content: toStoredContent(message.content),
    imageUrls,
    ts: new Date(message.timestamp).toISOString(),
    channelID: channel.id,
    guildID: guild.id
  }
}

// Whether the limits now reach further than those a finished channel was read with: an older start
// (or none) or more messages (or no limit).
function widened (state, since, max) {
  const wasStart = state.limit_start === null || state.limit_start === undefined ? -Infinity : new Date(state.limit_start).getTime()
  const wasMax = state.limit_max ?? null
  return since < wasStart || (wasMax !== null && (max === null || max > wasMax))
}

// Reads the channel's history back to the start of the window, from where the last read stopped.
// Resolves to how many messages were new.
async function readChannel (guild, channel, { wait = delay(), now = Date.now(), getMessages = (id, options) => global.bot.getMessages(id, options) } = {}) {
  const state = await store.backfillState(channel.id)
  const since = startOf(now)
  const max = maxMessages()
  if (state?.done && (state.reached_start || !widened(state, since, max))) return 0
  let before = state?.before_id || undefined
  let read = state?.read_count || 0
  let added = 0
  const save = (done, reachedStart = false) => store.saveBackfill(guild.id, channel.id, {
    beforeID: before || null, done, readCount: read, reachedStart, limitStart: since === -Infinity ? null : new Date(since), limitMax: max
  })
  for (;;) {
    const left = max === null ? PAGE_SIZE : Math.min(PAGE_SIZE, max - read)
    if (left <= 0) {
      await save(true)
      return added
    }
    // Newest first, as Discord returns them. A message Eris could not read comes back as null: left
    // out, but still counted for whether the page was full.
    const page = await getMessages(channel.id, { limit: left, ...(before ? { before } : {}) })
    const batch = page.filter(Boolean)
      .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
    const inWindow = batch.filter(m => m.timestamp >= since)
    added += await store.saveHistory(inWindow.map(m => toRow(m, guild, channel)).filter(Boolean))
    read += inWindow.length
    // Only as far as what was in the window: a wider window later reads on from there.
    if (inWindow.length) before = inWindow[inWindow.length - 1].id
    if (inWindow.length < batch.length) {
      await save(true)
      return added
    }
    if (page.length < left) {
      await save(true, true) // the start of the channel
      return added
    }
    if (max !== null && read >= max) {
      await save(true)
      return added
    }
    await save(false)
    await sleep(wait)
  }
}

// Reads back the server's channels, if it keeps messages. Resolves to how many were new.
async function backfillGuild (guild, options = {}) {
  if (!global.bot.guildSettingsCache[guild.id]) await cacheGuild(guild.id)
  const settings = global.bot.guildSettingsCache[guild.id]
  // No delete/edit log: nothing stored could ever be read back (as for live messages).
  if (!settings?.needsMessageCache()) return 0
  let added = 0
  for (const channel of channelsOf(guild, settings)) {
    try {
      added += await readChannel(guild, channel, options)
    } catch (e) {
      // Missing Access and the like: tried again next run.
      global.logger.warn(`[HISTORY]: Could not read #${channel.name} (${channel.id}) in ${guild.id}: ${e.message}`)
    }
  }
  return added
}

let running = false
async function runAll () {
  if (running || !enabled()) return
  running = true
  try {
    for (const guild of global.bot.guilds.values()) {
      const added = await backfillGuild(guild).catch(e => {
        global.logger.warn(`[HISTORY]: Could not read back ${guild.id}: ${e.message}`)
        return 0
      })
      if (added) global.logger.info(`[HISTORY]: Stored ${added} past message(s) of ${guild.id}`)
    }
  } finally {
    running = false
  }
}

function startHistoryBackfill () {
  if (!enabled()) return
  setTimeout(runAll, FIRST_RUN_MS)
  setInterval(runAll, RUN_EVERY_MS)
}

module.exports = { startHistoryBackfill, runAll, backfillGuild, readChannel, channelsOf, toRow, startOf, maxMessages, enabled }
