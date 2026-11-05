// The Twitch channels the bot follows (TWITCH_CHANNELS: logins, comma-separated; the same for every
// server) and their archives, read every TWITCH_SYNC_MINUTES (default 60) by the worker owning
// shard 0, so the mention assistant can answer about past streams (search_twitch). Only the list:
// title, date, length and link. Twitch does not let anyone else read a video's content, so there is
// no summary of what was said. Needs TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.
const twitch = require('../utils/twitch')
const store = require('../../db/interfaces/postgres/twitch')

const DEFAULT_SYNC_MINUTES = 60

function logins () {
  return String(process.env.TWITCH_CHANNELS || '').split(',').map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(l => /^\w{2,25}$/.test(l))
}

function enabled () {
  return twitch.configured() && logins().length !== 0
}

// Follows the channels of TWITCH_CHANNELS. If one cannot be found, nothing changes (a typo must
// not drop a channel and its archives). Resolves to the channels followed.
async function applyChannels () {
  const wanted = logins()
  const channels = await twitch.getChannels(wanted)
  const missing = wanted.filter(l => !channels.some(c => c.login.toLowerCase() === l))
  if (missing.length) throw new Error(`TWITCH_CHANNELS: no Twitch channel ${missing.join(', ')}`)
  await store.setChannels(channels)
  return channels
}

// Reads every followed channel's archives. Resolves to how many were new.
async function syncAll () {
  let added = 0
  for (const channel of await store.listChannels()) {
    const { videos, complete } = await twitch.getArchives(channel.user_id)
    added += await store.saveArchives(channel.user_id, videos, { complete })
  }
  return added
}

let running = false
async function runOnce () {
  if (running) return
  running = true
  try {
    await applyChannels().catch(e => global.logger.warn(`[TWITCH]: Could not follow the channels of TWITCH_CHANNELS, keeping those followed: ${e.message}`))
    const added = await syncAll()
    if (added) global.logger.info(`[TWITCH]: ${added} new archive(s)`)
  } catch (e) {
    global.logger.warn(`[TWITCH]: Sync failed: ${e.message}`)
  } finally {
    running = false
  }
}

function startTwitch () {
  if (!enabled()) return null
  const n = Number(process.env.TWITCH_SYNC_MINUTES)
  const minutes = process.env.TWITCH_SYNC_MINUTES && Number.isFinite(n) && n >= 5 ? n : DEFAULT_SYNC_MINUTES
  global.logger.startup?.(`[TWITCH]: Following ${logins().join(', ')}.`)
  runOnce()
  return setInterval(runOnce, minutes * 60 * 1000)
}

module.exports = { logins, enabled, applyChannels, syncAll, runOnce, startTwitch }
