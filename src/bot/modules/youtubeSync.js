// Keeping each server's YouTube knowledge current: the sync /youtube runs, the same sync run
// automatically when the channel has something new, and summaries of the newest videos in bulk.
const { parseChannelRef, fetchChannelKnowledge, durationSeconds } = require('../utils/youtube')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const videoSummary = require('./videoSummary')
const { ownerFirst } = require('../utils/priority')

const DEFAULT_AUTO_SYNC_MINUTES = 15
const FEED_TIMEOUT_MS = 15000
const MAX_SUMMARIES = 50

// Reads the configured channel from YouTube and adds to what is stored: the whole channel the first
// time, afterwards only what is new (plus the newest page again, for streams that changed state).
async function sync (guildID) {
  const stored = await youtubeDB.getOverview(guildID)
  const knownIds = await youtubeDB.getVideoIds(guildID)
  // Rows set before channel IDs were stored have only the reference.
  const ref = stored.channel_id ? { id: stored.channel_id } : parseChannelRef(stored.channel_ref)
  const knowledge = await fetchChannelKnowledge(ref, process.env.YOUTUBE_API_KEY, { knownIds, backfillToken: stored.backfill_token })
  await youtubeDB.saveSync(guildID, knowledge)
  const added = new Set(knowledge.videos.filter(v => !knownIds.has(v.id)).map(v => v.id)).size
  const note = [`新しく ${added} 件の動画を保存しました。`]
  if (knowledge.backfillToken) note.push('動画が多いため、残りの古い動画は次の `/youtube sync` で続きから取得します（自動の取得でも続きを読みます）。')
  return { knowledge: await youtubeDB.getKnowledge(guildID), note: note.join(''), added }
}

// The video IDs in the channel's public feed (its newest uploads), which costs no API quota.
async function feedVideoIds (channelID) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelID)}`, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`YouTube feed for ${channelID} failed: HTTP ${res.status}`)
  return [...(await res.text()).matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map(m => m[1])
}

// Syncs one server if there is anything to pick up: a video not stored yet (seen in the free feed),
// a live or upcoming stream whose state may have changed, or older videos left from a first read.
// Resolves to the number of videos added, or null when nothing needed doing.
async function syncIfChanged (guildID) {
  const stored = await youtubeDB.getOverview(guildID)
  if (!stored?.channel_id) return null
  let reason = stored.backfill_token ? 'backfill' : stored.live_count ? 'live' : null
  if (!reason) {
    const known = await youtubeDB.getVideoIds(guildID)
    if ((await feedVideoIds(stored.channel_id)).some(id => !known.has(id))) reason = 'new video'
  }
  if (!reason) return null
  const { added } = await sync(guildID)
  global.logger.info(`[YOUTUBE]: Synced ${guildID} automatically (${reason}), ${added} new video(s)`)
  return added
}

function autoSyncMinutes () {
  const raw = process.env.YOUTUBE_AUTO_SYNC_MINUTES
  const minutes = Number(raw)
  return raw && Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_AUTO_SYNC_MINUTES
}

let running = false
// One pass over the servers this worker hosts; each worker handles its own, so none is done twice.
async function autoSyncAll () {
  if (running) return
  running = true
  try {
    const channels = await youtubeDB.listChannels()
    for (const { guild_id: guildID } of ownerFirst(channels.filter(c => global.bot.guilds.has(c.guild_id)), c => c.guild_id)) {
      await syncIfChanged(guildID).catch(e => global.logger.warn(`[YOUTUBE]: Automatic sync of ${guildID} failed: ${e.message}`))
    }
  } catch (e) {
    global.logger.warn(`[YOUTUBE]: Automatic sync failed: ${e.message}`)
  } finally {
    running = false
  }
}

// A push from YouTube (an upload, a new stream, or a title or description changed): sync every
// server this worker hosts that set that channel.
async function syncOnPush (channelID) {
  const channels = (await youtubeDB.listChannels()).filter(c => c.channel_id === channelID && global.bot.guilds.has(c.guild_id))
  for (const { guild_id: guildID } of channels) {
    await sync(guildID)
      .then(({ added }) => global.logger.info(`[YOUTUBE]: Synced ${guildID} on a YouTube push, ${added} new video(s)`))
      .catch(e => global.logger.warn(`[YOUTUBE]: Sync of ${guildID} on a push failed: ${e.message}`))
  }
}

// With YouTube pushes set up (websub.js), a channel is synced when YouTube says something changed;
// without them, every YOUTUBE_AUTO_SYNC_MINUTES.
function startAutoSync () {
  if (!process.env.YOUTUBE_API_KEY) return null
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

module.exports = { sync, syncIfChanged, syncOnPush, autoSyncAll, startAutoSync, feedVideoIds, videosToSummarize, summarizeLatest, shortestFirst, summaryConcurrency, MAX_SUMMARIES }
