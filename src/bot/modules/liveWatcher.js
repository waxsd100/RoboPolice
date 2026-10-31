// Turns a server's YouTube streams into Discord scheduled events, for servers that turned it on
// (/youtube liveevents). Only streams: ordinary videos never become events.
//
// A stream's event follows it: made when the stream is scheduled (or, unscheduled, when it starts),
// moved when the start time changes, started when it goes live, kept open while it runs, and ended
// or cancelled afterwards. Each worker watches the servers it hosts every
// YOUTUBE_LIVE_POLL_SECONDS (default 60); a push from YouTube (websub.js) checks a channel at once.
//
// What to look at costs little: the channel's public feed shows new uploads and streams without API
// quota, and only those, plus streams already upcoming or live, are read from the API (1 unit for
// up to 50).
const cluster = require('cluster')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const { fetchVideos } = require('../utils/youtube')
const { feedVideoIds } = require('./youtubeSync')
const urlFetcher = require('../utils/urlFetcher')
const { cropTo, SIZES } = require('../utils/imageCrop')
const { describeStream } = require('./streamBlurb')
const { isGatewayConfigured } = require('../utils/aiGateway')

const DEFAULT_POLL_SECONDS = 60
const DEFAULT_LENGTH_MS = 2 * 60 * 60 * 1000
// Discord wants an event's start in the future, even for one that is started straight away.
const START_MARGIN_MS = 60 * 1000
// A running stream's event is kept open by pushing its end back before it is reached.
const EXTEND_BEFORE_MS = 15 * 60 * 1000
const EXTEND_BY_MS = 60 * 60 * 1000
const STATUS = { scheduled: 1, active: 2, completed: 3, canceled: 4 }
// Discord takes up to 1000 characters; the stream's URL goes last.
const MAX_DESCRIPTION = 1000

function pollSeconds () {
  const raw = process.env.YOUTUBE_LIVE_POLL_SECONDS
  const seconds = Number(raw)
  return raw && Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_POLL_SECONDS
}

function request (method, url, body) {
  return global.bot.requestHandler.request(method, url, true, body)
}

// The stream's thumbnail ({ buffer, mimeType }), or null if it can't be read.
async function thumbnailOf (video) {
  if (!video.thumbnail) return null
  try {
    const { buffer, contentType } = await urlFetcher.fetchImage(video.thumbnail)
    return { buffer, mimeType: contentType || 'image/jpeg' }
  } catch (_) {
    return null
  }
}

// The thumbnail as an event cover, or nothing.
async function coverOf (thumbnail) {
  if (!thumbnail) return {}
  try {
    return { image: `data:image/jpeg;base64,${(await cropTo(thumbnail.buffer, SIZES.eventCover)).toString('base64')}` }
  } catch (_) {
    return {}
  }
}

// What the AI says the stream is about (when it can), then as much of the stream's description as
// fits, then its URL.
function eventDescription (video, blurb) {
  const tail = `\n\n${video.url}`
  const head = blurb ? `${blurb}\n\n` : ''
  const room = Math.max(MAX_DESCRIPTION - head.length - tail.length, 0)
  const own = (video.description || '').trim()
  const excerpt = own.length > room ? `${own.slice(0, Math.max(room - 1, 0))}…` : own
  return `${head}${excerpt}${tail}`.trim()
}

async function createEvent (guild, video, start) {
  const end = new Date(start.getTime() + DEFAULT_LENGTH_MS)
  const thumbnail = await thumbnailOf(video)
  const blurb = await describeStream(video, thumbnail)
  const created = await request('POST', `/guilds/${guild.id}/scheduled-events`, {
    name: video.title.slice(0, 100),
    description: eventDescription(video, blurb),
    privacy_level: 2,
    entity_type: 3,
    entity_metadata: { location: video.url.slice(0, 100) },
    scheduled_start_time: start.toISOString(),
    scheduled_end_time: end.toISOString(),
    ...(await coverOf(thumbnail)),
    reason: 'YouTube stream'
  })
  return { eventID: created.id, scheduledEnd: end }
}

function setStatus (guild, eventID, status) {
  return request('PATCH', `/guilds/${guild.id}/scheduled-events/${eventID}`, { status: STATUS[status] })
}

// Discord answers 404 (Unknown Guild Scheduled Event) for an event someone deleted.
const isGone = e => /404|Unknown Guild Scheduled Event/.test(String(e?.message || e))

// Moves one stream's event along. `record` is what is stored for it (or undefined), `video` its
// current state from YouTube (or null if it is gone). Resolves to the record to store, or null when
// nothing changed.
async function follow (guild, video, record, now = new Date()) {
  const state = !video ? 'gone' : video.liveStatus
  if (!record) {
    if (state === 'upcoming') {
      const wanted = video.scheduledStart ? new Date(video.scheduledStart) : now
      const start = new Date(Math.max(wanted.getTime(), now.getTime() + START_MARGIN_MS))
      const { eventID, scheduledEnd } = await createEvent(guild, video, start)
      return { eventID, status: 'scheduled', scheduledStart: video.scheduledStart, scheduledEnd }
    }
    if (state === 'live') {
      const { eventID, scheduledEnd } = await createEvent(guild, video, new Date(now.getTime() + START_MARGIN_MS))
      await setStatus(guild, eventID, 'active')
      return { eventID, status: 'active', scheduledStart: video.scheduledStart, scheduledEnd }
    }
    return null // a stream that ended before it was seen, or not a stream
  }

  const next = { eventID: record.event_id, status: record.status, scheduledStart: record.scheduled_start, scheduledEnd: record.scheduled_end }
  if (record.status === 'scheduled') {
    if (state === 'upcoming') {
      const moved = video.scheduledStart && new Date(video.scheduledStart).getTime() !== new Date(record.scheduled_start || 0).getTime()
      if (!moved || new Date(video.scheduledStart) <= now) return null
      const start = new Date(video.scheduledStart)
      const end = new Date(start.getTime() + DEFAULT_LENGTH_MS)
      await request('PATCH', `/guilds/${guild.id}/scheduled-events/${record.event_id}`, { scheduled_start_time: start.toISOString(), scheduled_end_time: end.toISOString() })
      return { ...next, scheduledStart: video.scheduledStart, scheduledEnd: end }
    }
    if (state === 'live') {
      await setStatus(guild, record.event_id, 'active')
      return { ...next, status: 'active' }
    }
    // Over before it was seen live: it still happened if it has a real start; otherwise it was called off.
    if (video?.actualStart) {
      await setStatus(guild, record.event_id, 'active')
      await setStatus(guild, record.event_id, 'completed')
      return { ...next, status: 'completed' }
    }
    await setStatus(guild, record.event_id, 'canceled')
    return { ...next, status: 'canceled' }
  }
  if (record.status === 'active') {
    if (state === 'live') {
      const end = new Date(record.scheduled_end || 0)
      if (end.getTime() - now.getTime() > EXTEND_BEFORE_MS) return null
      const later = new Date(now.getTime() + EXTEND_BY_MS)
      await request('PATCH', `/guilds/${guild.id}/scheduled-events/${record.event_id}`, { scheduled_end_time: later.toISOString() })
      return { ...next, scheduledEnd: later }
    }
    if (state === 'upcoming') return null
    await setStatus(guild, record.event_id, 'completed')
    return { ...next, status: 'completed' }
  }
  return null // completed, canceled or gone: nothing more to do
}

// Checks one server: new streams from the feed, and the state of the ones being followed.
// Resolves to the number of events changed.
async function checkGuild (guildID, channelID) {
  const guild = global.bot.guilds.get(guildID)
  if (!guild) return 0
  const [known, liveIds, records] = await Promise.all([youtubeDB.getVideoIds(guildID), youtubeDB.getLiveVideoIds(guildID), youtubeDB.getLiveEvents(guildID)])
  const fresh = (await feedVideoIds(channelID)).filter(id => !known.has(id))
  const open = Object.entries(records).filter(([, r]) => r.status === 'scheduled' || r.status === 'active').map(([id]) => id)
  const ids = [...new Set([...fresh, ...liveIds, ...open])]
  if (ids.length === 0) return 0
  const videos = await fetchVideos(ids, process.env.YOUTUBE_API_KEY)
  await youtubeDB.upsertVideos(guildID, videos)
  if (!guild.members.get(global.bot.user.id)?.permissions.has('manageEvents')) {
    global.logger.warn(`[LIVE]: Cannot make events in ${guildID}: the bot lacks Manage Events`)
    return 0
  }
  const byId = new Map(videos.map(v => [v.id, v]))
  let changed = 0
  for (const id of ids) {
    const video = byId.get(id) || null
    if (video && !video.isStream) continue
    try {
      const next = await follow(guild, video, records[id])
      if (next) {
        await youtubeDB.saveLiveEvent(guildID, id, next)
        changed++
      }
    } catch (e) {
      if (records[id] && isGone(e)) {
        // Someone deleted the event: leave this stream alone from now on.
        await youtubeDB.saveLiveEvent(guildID, id, { eventID: records[id].event_id, status: 'gone', scheduledStart: records[id].scheduled_start, scheduledEnd: records[id].scheduled_end })
      } else {
        global.logger.warn(`[LIVE]: Could not update the event for ${id} in ${guildID}: ${e.message}`)
      }
    }
  }
  return changed
}

// The servers this worker hosts that turned stream events on, optionally only those of one channel.
async function watchedGuilds (channelID = null) {
  return (await youtubeDB.listChannels())
    .filter(c => c.live_events && global.bot.guilds.has(c.guild_id) && (!channelID || c.channel_id === channelID))
}

// Once a stream is over and YouTube has its archive, what was said in it is summarized and stored
// like any video summary, for the mention assistant (LIVE_ARCHIVE_SUMMARY=false turns it off).
// An archive is first tried 30 minutes after the stream ends, then hourly, at most three times.
// One at a time per worker, in the background: a summary takes minutes and the poll must go on.
let summarizingArchive = false
function archiveSummariesEnabled () {
  return isGatewayConfigured() && process.env.LIVE_ARCHIVE_SUMMARY !== 'false'
}

async function summarizeArchives (guildID) {
  if (summarizingArchive || !archiveSummariesEnabled()) return null
  summarizingArchive = true
  try {
    const [archive] = await youtubeDB.archivesToSummarize(guildID)
    if (!archive) return null
    await youtubeDB.recordArchiveAttempt(guildID, archive.video_id)
    await require('./videoSummary').summarizeVideo(guildID, archive.url)
    global.logger.info(`[LIVE]: Summarized the archive of ${archive.video_id} in ${guildID}`)
    return archive.video_id
  } catch (e) {
    global.logger.warn(`[LIVE]: Could not summarize an archive in ${guildID}, trying again later: ${e.message}`)
    return null
  } finally {
    summarizingArchive = false
  }
}

// One periodic pass at a time; a push checks its channel right away, alongside.
let polling = false
async function checkAll (channelID = null) {
  if (!channelID) {
    if (polling) return
    polling = true
  }
  try {
    for (const { guild_id: guildID, channel_id: id } of await watchedGuilds(channelID)) {
      await checkGuild(guildID, id).catch(e => global.logger.warn(`[LIVE]: Checking ${guildID} failed: ${e.message}`))
      summarizeArchives(guildID) // not awaited
    }
  } catch (e) {
    global.logger.warn(`[LIVE]: Checking streams failed: ${e.message}`)
  } finally {
    if (!channelID) polling = false
  }
}

function startWatcher () {
  const seconds = pollSeconds()
  if (!process.env.YOUTUBE_API_KEY || seconds === 0) return null
  // A push from YouTube, relayed by the master process.
  cluster.worker?.on('message', message => {
    if (message?.type === 'youtubePush' && message.channelID) checkAll(message.channelID)
  })
  return setInterval(() => checkAll(), seconds * 1000)
}

module.exports = { startWatcher, checkAll, checkGuild, follow, summarizeArchives, eventDescription, STATUS }
