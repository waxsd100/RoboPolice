// Turns a server's YouTube streams, and new uploads, into Discord scheduled events, for servers
// that turned it on (/youtube liveevents).
//
// An upload's event (UPLOAD_EVENTS=false turns these off) starts as soon as the video is seen in
// the channel's feed and stays open for UPLOAD_EVENT_HOURS (default 24), so members see the new
// video in the server's events; then it is ended. Only uploads made in the last
// UPLOAD_EVENT_MAX_AGE_HOURS (default 6) count, so turning this on does not post old videos.
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
const { ownerFirst } = require('../utils/priority')
const { isGatewayConfigured } = require('../utils/aiGateway')

const DEFAULT_POLL_SECONDS = 60
const DEFAULT_LENGTH_MS = 2 * 60 * 60 * 1000
// Discord wants an event's start in the future, even for one that is started straight away.
const START_MARGIN_MS = 60 * 1000
// A running stream's event is kept open by pushing its end back before it is reached.
const EXTEND_BEFORE_MS = 15 * 60 * 1000
const EXTEND_BY_MS = 60 * 60 * 1000
const STATUS = { scheduled: 1, active: 2, completed: 3, canceled: 4 }
const DEFAULT_UPLOAD_EVENT_HOURS = 24
const DEFAULT_UPLOAD_MAX_AGE_HOURS = 6

function hoursSetting (name, fallback) {
  const n = Number(process.env[name])
  return process.env[name] && n > 0 ? n : fallback
}

function uploadEventsEnabled () {
  return process.env.UPLOAD_EVENTS !== 'false'
}
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

// What the AI says the stream is about (when it can), the pages of the games played (games:
// [{ name, url }]), then as much of the stream's description as fits, then its URL.
function eventDescription (video, blurb, games = []) {
  const tail = `\n\n${video.url}`
  const gameLines = games.map(g => `🎮 ${g.mention ? `${g.mention} ` : ''}${g.name}${g.url ? `: ${g.url}` : ''}`).join('\n')
  const head = [blurb, gameLines].filter(Boolean).map(part => `${part}\n\n`).join('')
  const room = Math.max(MAX_DESCRIPTION - head.length - tail.length, 0)
  const own = (video.description || '').trim()
  const excerpt = own.length > room ? `${own.slice(0, Math.max(room - 1, 0))}…` : own
  return `${head}${excerpt}${tail}`.trim()
}

async function createEvent (guild, video, start, { upload = false, length = DEFAULT_LENGTH_MS } = {}) {
  const end = new Date(start.getTime() + length)
  const thumbnail = await thumbnailOf(video)
  // An upload is already out: its own description says what it is, with no AI line.
  const described = upload ? null : await describeStream(video, thumbnail, guild.id)
  const created = await request('POST', `/guilds/${guild.id}/scheduled-events`, {
    name: `${upload ? '📺 新着動画: ' : ''}${video.title}`.slice(0, 100),
    description: eventDescription(video, described?.blurb, described?.games),
    privacy_level: 2,
    entity_type: 3,
    entity_metadata: { location: video.url.slice(0, 100) },
    scheduled_start_time: start.toISOString(),
    scheduled_end_time: end.toISOString(),
    ...(await coverOf(thumbnail)),
    reason: upload ? 'YouTube upload' : 'YouTube stream'
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

// A new upload's event: started at once, open for UPLOAD_EVENT_HOURS. Null for one too old to announce.
async function announceUpload (guild, video, now = new Date()) {
  const published = new Date(video.publishedAt || 0)
  if (now - published > hoursSetting('UPLOAD_EVENT_MAX_AGE_HOURS', DEFAULT_UPLOAD_MAX_AGE_HOURS) * 3600 * 1000) return null
  const start = new Date(now.getTime() + START_MARGIN_MS)
  const { eventID, scheduledEnd } = await createEvent(guild, video, start, { upload: true, length: hoursSetting('UPLOAD_EVENT_HOURS', DEFAULT_UPLOAD_EVENT_HOURS) * 3600 * 1000 })
  await setStatus(guild, eventID, 'active')
  return { eventID, status: 'active', scheduledStart: start, scheduledEnd, kind: 'upload' }
}

// An upload's event once its time is up: ended (Discord may have ended it already).
async function endUpload (guild, record, now = new Date()) {
  if (record.status !== 'active' || new Date(record.scheduled_end || 0) > now) return null
  await setStatus(guild, record.event_id, 'completed').catch(e => { if (!/400|completed/i.test(e.message)) throw e })
  return { eventID: record.event_id, status: 'completed', scheduledStart: record.scheduled_start, scheduledEnd: record.scheduled_end, kind: 'upload' }
}

// Checks one channel for the servers `guildIDs` (those this worker hosts that turned events on):
// new streams and uploads, and the state of the ones being followed. The channel's videos are read
// once for all of them. Resolves to the number of events changed.
async function checkChannel (channelID, guildIDs, now = new Date()) {
  const guilds = guildIDs.map(id => global.bot.guilds.get(id)).filter(Boolean)
  if (guilds.length === 0) return 0
  const since = new Date(now.getTime() - hoursSetting('UPLOAD_EVENT_MAX_AGE_HOURS', DEFAULT_UPLOAD_MAX_AGE_HOURS) * 3600 * 1000)
  const [known, liveIds, recent] = await Promise.all([youtubeDB.getVideoIds(channelID), youtubeDB.getLiveVideoIds(channelID), youtubeDB.recentVideoIds(channelID, since)])
  const recordsOf = new Map(await Promise.all(guilds.map(async g => [g.id, await youtubeDB.getLiveEvents(g.id, channelID)])))
  const fresh = (await feedVideoIds(channelID)).filter(id => !known.has(id))
  const records = [...recordsOf.values()]
  const open = records.flatMap(r => Object.entries(r).filter(([, e]) => e.status === 'scheduled' || e.status === 'active').map(([id]) => id))
  // Recent uploads some server has no event for yet (another worker may have stored them first).
  const unannounced = uploadEventsEnabled() ? recent.filter(id => records.some(r => !r[id])) : []
  const ids = [...new Set([...fresh, ...liveIds, ...open, ...unannounced])]
  if (ids.length === 0) return 0
  const videos = await fetchVideos(ids, process.env.YOUTUBE_API_KEY)
  await youtubeDB.upsertVideos(channelID, videos)
  let changed = 0
  for (const guild of guilds) changed += await updateGuild(guild, ids, new Map(videos.map(v => [v.id, v])), recordsOf.get(guild.id))
  return changed
}

// One server's events for the channel's videos `ids` (byId: their current state from YouTube).
async function updateGuild (guild, ids, byId, records) {
  if (!guild.members.get(global.bot.user.id)?.permissions.has('manageEvents')) {
    global.logger.warn(`[LIVE]: Cannot make events in ${guild.id}: the bot lacks Manage Events`)
    return 0
  }
  let changed = 0
  for (const id of ids) {
    const video = byId.get(id) || null
    const record = records[id]
    const upload = record ? record.kind === 'upload' : !!(video && !video.isStream)
    // A new upload is announced while it is recent (announceUpload); an older one is left alone.
    if (upload && !record && !uploadEventsEnabled()) continue
    try {
      const next = upload
        ? (record ? await endUpload(guild, record) : await announceUpload(guild, video))
        : await follow(guild, video, record)
      if (next) {
        await youtubeDB.saveLiveEvent(guild.id, id, next)
        changed++
      }
    } catch (e) {
      if (record && isGone(e)) {
        // Someone deleted the event: leave this video alone from now on.
        await youtubeDB.saveLiveEvent(guild.id, id, { eventID: record.event_id, status: 'gone', scheduledStart: record.scheduled_start, scheduledEnd: record.scheduled_end, kind: record.kind })
      } else {
        global.logger.warn(`[LIVE]: Could not update the event for ${id} in ${guild.id}: ${e.message}`)
      }
    }
  }
  return changed
}

// One server and one channel (checkChannel for a single server).
function checkGuild (guildID, channelID) {
  return checkChannel(channelID, [guildID])
}

// The servers this worker hosts that turned stream events on.
async function watchedGuilds () {
  return ownerFirst((await youtubeDB.listLiveEventGuilds()).filter(id => global.bot.guilds.has(id)))
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
    await youtubeDB.recordArchiveAttempt(archive.video_id)
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
    const guildIDs = await watchedGuilds()
    if (guildIDs.length === 0) return
    for (const { channel_id: id } of (await youtubeDB.listChannels()).filter(c => !channelID || c.channel_id === channelID)) {
      await checkChannel(id, guildIDs).catch(e => global.logger.warn(`[LIVE]: Checking ${id} failed: ${e.message}`))
    }
    for (const guildID of guildIDs) summarizeArchives(guildID) // not awaited
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

module.exports = { startWatcher, checkAll, checkGuild, checkChannel, follow, announceUpload, endUpload, summarizeArchives, eventDescription, STATUS }
