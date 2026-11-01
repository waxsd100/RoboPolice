// Keeping the YouTube knowledge current: the channels the bot follows (YOUTUBE_CHANNELS, one list
// for every server), the sync /youtube runs, the same sync run automatically when a channel has
// something new, and summaries of the newest videos in bulk.
const { parseChannelRef, resolveChannel, fetchChannelKnowledge, durationSeconds } = require('../utils/youtube')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const videoSummary = require('./videoSummary')
const { knowledgeSetting } = require('../utils/knowledgeDefaults')

const DEFAULT_AUTO_SYNC_MINUTES = 15
const FEED_TIMEOUT_MS = 15000
const MAX_SUMMARIES = 50

// The channels named in YOUTUBE_CHANNELS (comma-separated: @name, a channel URL or its ID).
function configuredChannels () {
  return String(knowledgeSetting('YOUTUBE_CHANNELS')).split(',').map(s => s.trim()).filter(Boolean)
}

// Makes the bot follow the channels named in YOUTUBE_CHANNELS. All of them are resolved first: if
// one cannot be, nothing changes (a typo must not drop a channel and its videos). Resolves to the
// channels followed, or null when nothing changed.
async function applyConfiguredChannels () {
  const refs = configuredChannels()
  if (!refs.length || !process.env.YOUTUBE_API_KEY) return null
  const channels = []
  for (const ref of refs) {
    const parsed = parseChannelRef(ref)
    if (!parsed) throw new Error(`YOUTUBE_CHANNELS: "${ref}" is not a channel`)
    const id = parsed.id || (await resolveChannel(parsed, process.env.YOUTUBE_API_KEY)).id
    channels.push({ ref, id })
  }
  await youtubeDB.setBotChannels(channels)
  return channels
}

// Reads one channel from YouTube and adds to what is stored: the whole channel the first time,
// afterwards only what is new (plus the newest page again, for streams that changed state).
// Resolves to { added, more } (more: older videos are left for the next sync).
async function syncChannel (channel) {
  const knownIds = await youtubeDB.getVideoIds(channel.channel_id)
  const knowledge = await fetchChannelKnowledge({ id: channel.channel_id }, process.env.YOUTUBE_API_KEY, { knownIds, backfillToken: channel.backfill_token })
  await youtubeDB.saveSync(knowledge)
  return { added: new Set(knowledge.videos.filter(v => !knownIds.has(v.id)).map(v => v.id)).size, more: !!knowledge.backfillToken }
}

// Syncs every channel the bot follows, for /youtube sync. guildID: whose view to return.
async function sync (guildID) {
  let added = 0
  let more = false
  for (const channel of await youtubeDB.listChannels()) {
    const result = await syncChannel(channel)
    added += result.added
    more = more || result.more
  }
  const note = [`新しく ${added} 件の動画を保存しました。`]
  if (more) note.push('動画が多いため、残りの古い動画は次の `/youtube sync` で続きから取得します（自動の取得でも続きを読みます）。')
  return { knowledge: await youtubeDB.getKnowledge(guildID), note: note.join(''), added }
}

// The video IDs in the channel's public feed (its newest uploads), which costs no API quota.
async function feedVideoIds (channelID) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelID)}`, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`YouTube feed for ${channelID} failed: HTTP ${res.status}`)
  return [...(await res.text()).matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map(m => m[1])
}

// Syncs one channel if there is anything to pick up: a video not stored yet (seen in the free
// feed), a live or upcoming stream whose state may have changed, or older videos left from a first
// read. Resolves to the number of videos added, or null when nothing needed doing.
async function syncIfChanged (channel) {
  let reason = channel.backfill_token ? 'backfill' : (await youtubeDB.getLiveVideoIds(channel.channel_id)).length ? 'live' : null
  if (!reason) {
    const known = await youtubeDB.getVideoIds(channel.channel_id)
    if ((await feedVideoIds(channel.channel_id)).some(id => !known.has(id))) reason = 'new video'
  }
  if (!reason) return null
  const { added } = await syncChannel(channel)
  global.logger.info(`[YOUTUBE]: Synced ${channel.title || channel.channel_id} automatically (${reason}), ${added} new video(s)`)
  return added
}

function autoSyncMinutes () {
  const raw = process.env.YOUTUBE_AUTO_SYNC_MINUTES
  const minutes = Number(raw)
  return raw && Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_AUTO_SYNC_MINUTES
}

// The channels are the bot's, not a server's: one worker (the one owning shard 0) syncs them.
const syncsHere = () => !global.bot?.shards || !!global.bot.shards.find?.(s => s.id === 0) || global.bot.shards.has?.(0)

let running = false
// One pass over the channels the bot follows.
async function autoSyncAll () {
  if (running || !syncsHere()) return
  running = true
  try {
    for (const channel of await youtubeDB.listChannels()) {
      await syncIfChanged(channel).catch(e => global.logger.warn(`[YOUTUBE]: Automatic sync of ${channel.channel_id} failed: ${e.message}`))
    }
  } catch (e) {
    global.logger.warn(`[YOUTUBE]: Automatic sync failed: ${e.message}`)
  } finally {
    running = false
  }
}

// A push from YouTube (an upload, a new stream, or a title or description changed): sync that
// channel, if the bot follows it.
async function syncOnPush (channelID) {
  if (!syncsHere()) return
  const channel = (await youtubeDB.listChannels()).find(c => c.channel_id === channelID)
  if (!channel) return
  await syncChannel(channel)
    .then(({ added }) => global.logger.info(`[YOUTUBE]: Synced ${channel.title || channelID} on a YouTube push, ${added} new video(s)`))
    .catch(e => global.logger.warn(`[YOUTUBE]: Sync of ${channelID} on a push failed: ${e.message}`))
}

// At startup: the channels named in YOUTUBE_CHANNELS are followed (on the worker owning shard 0),
// then, with YouTube pushes set up (websub.js), a channel is synced when YouTube says something
// changed; without them, every YOUTUBE_AUTO_SYNC_MINUTES.
function startAutoSync () {
  if (!process.env.YOUTUBE_API_KEY) return null
  if (syncsHere()) {
    applyConfiguredChannels()
      .then(channels => channels && global.logger.startup(`[YOUTUBE]: Following ${channels.map(c => c.ref).join(', ')}.`))
      .then(() => autoSyncAll())
      .catch(e => global.logger.warn(`[YOUTUBE]: Could not follow the channels of YOUTUBE_CHANNELS, keeping those followed: ${e.message}`))
  }
  if (require('../../miscellaneous/websub').enabled()) {
    global.logger.startup('[YOUTUBE]: Syncing channels when YouTube pushes an upload.')
    require('cluster').worker?.on('message', message => {
      if (message?.type === 'youtubePush' && message.channelID) syncOnPush(message.channelID).catch(e => global.logger.warn(`[YOUTUBE]: ${e.message}`))
    })
    return null
  }
  const minutes = autoSyncMinutes()
  if (minutes === 0) return null
  global.logger.startup(`[YOUTUBE]: Checking channels for new videos every ${minutes} minutes.`)
  return setInterval(autoSyncAll, minutes * 60 * 1000)
}

// The newest `count` stored videos that have no summary yet (with force, whether or not they have
// one), skipping streams that are not over.
async function videosToSummarize (guildID, count, { force = false } = {}) {
  const knowledge = await youtubeDB.getKnowledge(guildID)
  return (knowledge?.videos || [])
    .filter(v => (force || !v.summary) && !['live', 'upcoming'].includes(v.live_status))
    .slice(0, Math.min(Math.max(count, 1), MAX_SUMMARIES))
}

const DEFAULT_CONCURRENCY = 3
const MAX_CONCURRENCY = 10

// How many videos are summarized at once (VIDEO_SUMMARY_CONCURRENCY). Each is one long Gemini
// call; more at once finish sooner but reach Gemini's per-minute limits sooner, in which case the
// calls wait and retry (eventDrafter.js).
function summaryConcurrency () {
  const n = Math.floor(Number(process.env.VIDEO_SUMMARY_CONCURRENCY))
  return n >= 1 ? Math.min(n, MAX_CONCURRENCY) : DEFAULT_CONCURRENCY
}

// The order the videos are summarized in: the shortest first, so the quick ones are done early
// and a long stream archive does not hold them up. Videos of unknown length go last.
function shortestFirst (videos) {
  const length = v => durationSeconds(v.duration) ?? Infinity
  return videos.map((video, i) => ({ video, i })).sort((a, b) => length(a.video) - length(b.video) || a.i - b.i).map(e => e.i)
}

// Summarizes them, a few at a time, the shortest first. onProgress({ done, total, running }) is
// called whenever one starts or ends (running: the videos being summarized now); force replaces
// stored summaries. Resolves to [{ video, error }] in the order of `videos`.
async function summarizeLatest (guildID, videos, { onProgress = () => {}, force = false, concurrency = summaryConcurrency() } = {}) {
  const results = new Array(videos.length)
  const order = shortestFirst(videos)
  const running = new Set()
  let next = 0
  let done = 0
  const report = () => Promise.resolve(onProgress({ done, total: videos.length, running: [...running] })).catch(() => {})
  async function worker () {
    while (next < order.length) {
      const i = order[next++]
      const video = videos[i]
      running.add(video)
      await report()
      try {
        await videoSummary.summarizeVideo(guildID, video.url, { force })
        results[i] = { video, error: null }
      } catch (e) {
        results[i] = { video, error: e.hint || e.message }
      }
      running.delete(video)
      done++
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, videos.length) }, worker))
  return results
}

module.exports = { sync, syncChannel, syncIfChanged, syncOnPush, autoSyncAll, startAutoSync, applyConfiguredChannels, configuredChannels, feedVideoIds, videosToSummarize, summarizeLatest, shortestFirst, summaryConcurrency, MAX_SUMMARIES }
