// Messages sent before the bot stored them: before it joined the server, before the server set a
// message log, or in channels quiet since. Live messages are stored as they arrive
// (events/messageCreate.js); this reads each channel's history back and stores what is missing,
// under the same rules: only servers with a message deletion or edit log, not ignored channels, not
// bots, not automod notices.
//
// How far back: HISTORY_BACKFILL_DAYS days (0 for everything), by default MESSAGE_HISTORY_DAYS
// (older ones would be pruned at once) or else 90. 100 messages a request, one request every
// HISTORY_BACKFILL_DELAY_MS; where each channel got to is kept (message_backfill), so a restart goes
// on from there. Every worker does the servers it hosts, checking hourly for new channels and
// servers that turned a message log on. HISTORY_BACKFILL=false turns it off.
const { toStoredContent } = require('../../db/interfaces/postgres/create')
const store = require('../../db/interfaces/postgres/messageHistory')
const cacheGuild = require('../utils/cacheGuild')

const PAGE_SIZE = 100
const DEFAULT_DAYS = 90
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

// How many days back to read; null for everything.
function days () {
  const own = setting('HISTORY_BACKFILL_DAYS')
  if (own !== null) return own === 0 ? null : own
  const retention = setting('MESSAGE_HISTORY_DAYS')
  return retention || DEFAULT_DAYS
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

// Reads the channel's history back to the start of the window, from where the last read stopped.
// Resolves to how many messages were new.
async function readChannel (guild, channel, { wait = delay(), now = Date.now(), getMessages = (id, options) => global.bot.getMessages(id, options) } = {}) {
  const state = await store.backfillState(channel.id)
  if (state?.done) return 0
  const window = days()
  const since = window === null ? -Infinity : now - window * 24 * 60 * 60 * 1000
  let before = state?.before_id || undefined
  let added = 0
  for (;;) {
    const batch = await getMessages(channel.id, { limit: PAGE_SIZE, ...(before ? { before } : {}) })
    const inWindow = batch.filter(m => m.timestamp >= since)
    added += await store.saveHistory(inWindow.map(m => toRow(m, guild, channel)).filter(Boolean))
    const done = batch.length < PAGE_SIZE || inWindow.length < batch.length
    if (batch.length) before = batch.reduce((oldest, m) => BigInt(m.id) < BigInt(oldest) ? m.id : oldest, batch[0].id)
    await store.saveBackfill(guild.id, channel.id, before || null, done)
    if (done) return added
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

module.exports = { startHistoryBackfill, runAll, backfillGuild, readChannel, channelsOf, toRow, days, enabled }
