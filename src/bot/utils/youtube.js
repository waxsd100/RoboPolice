// Reads a YouTube channel and its videos with the YouTube Data API v3. Every call used here costs 1
// quota unit: 1 for the channel plus 2 per page of 50 videos.
const { gatewayURL, gatewayAuthHeaders, isGatewayConfigured } = require('./aiGateway')

const DIRECT_API = 'https://www.googleapis.com/youtube/v3'
const PAGE_SIZE = 50 // the most playlistItems returns per page, and videos.list takes per call
// 5000 videos, 201 units: far under the default 10000 units a day, even for a first full read.
const MAX_PAGES = 100
const MAX_DESCRIPTION = 1000
const TIMEOUT_MS = 15000

class YouTubeError extends Error {
  constructor (message, hint) {
    super(message)
    this.hint = hint
  }
}

// Accepts what people paste: a channel URL (/@handle, /channel/UC…), "@handle", or a UC… ID.
// Handles may be in any script (@ロボポリス), and browsers copy those percent-encoded.
function parseChannelRef (input) {
  let text = String(input || '').trim()
  try {
    text = decodeURIComponent(text)
  } catch (_) {} // a stray % is not an encoding; keep the text as is
  const id = text.match(/(?:^|\/channel\/)(UC[\w-]{22})(?:[/?#]|$)/)
  if (id) return { id: id[1] }
  const handle = text.match(/(?:^|youtube\.com\/)@([^\s/?#&@]{3,30})(?:[/?#]|$)/iu)
  if (handle) return { handle: handle[1] }
  return null
}

// Through Cloudflare AI Gateway when YOUTUBE_GATEWAY_PROVIDER names a custom provider whose base URL
// is https://www.googleapis.com; straight to Google otherwise.
function apiBase () {
  const slug = process.env.YOUTUBE_GATEWAY_PROVIDER
  return slug && isGatewayConfigured() ? gatewayURL(`custom-${slug}/youtube/v3`) : DIRECT_API
}

async function call (path, params, apiKey) {
  const url = `${apiBase()}/${path}?${new URLSearchParams(params)}`
  // The key goes in a header rather than the query string, so it never appears in a logged URL.
  const headers = { 'x-goog-api-key': apiKey, ...(url.startsWith(DIRECT_API) ? {} : gatewayAuthHeaders()) }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) {
    const body = await res.text()
    throw new YouTubeError(`YouTube API ${path} failed: HTTP ${res.status} ${body.slice(0, 500)}`, `YouTube API の呼び出しに失敗しました（HTTP ${res.status}）`)
  }
  return res.json()
}

// The video IDs in text or YouTube links: watch?v=, youtu.be/, /shorts/, /live/ and /embed/.
const VIDEO_LINK_RE = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})(?![\w-])/g

function parseVideoIds (input) {
  const ids = []
  for (const m of String(input || '').matchAll(VIDEO_LINK_RE)) {
    if (!ids.includes(m[1])) ids.push(m[1])
  }
  return ids
}

function parseVideoId (input) {
  return parseVideoIds(input)[0] || null
}

// Times in a summary ([12:34] or [1:02:03]) as links that open the video there, so they can be
// quoted as they are.
function linkTimestamps (text, videoID) {
  return String(text || '').replace(/\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\](?!\()/g, (whole, h, m, s) => {
    const seconds = Number(h || 0) * 3600 + Number(m) * 60 + Number(s)
    return `[${whole.slice(1, -1)}](https://www.youtube.com/watch?v=${videoID}&t=${seconds}s)`
  })
}

// Seconds in a YouTube duration (ISO 8601, e.g. PT1H2M3S or P1DT2H), null when there is none or
// it can't be read.
function durationSeconds (duration) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(duration || ''))
  if (!m || !m.slice(1).some(Boolean)) return null
  const [d, h, min, sec] = m.slice(1).map(n => Number(n || 0))
  return ((d * 24 + h) * 60 + min) * 60 + sec
}

function formatDuration (duration) {
  const total = durationSeconds(duration)
  if (total === null) {
    const raw = String(duration || '').trim()
    return raw && raw !== 'P0D' ? raw : null
  }
  if (total === 0) return null
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts = []
  if (h) parts.push(`${h}時間`)
  if (m) parts.push(`${m}分`)
  if (s || !parts.length) parts.push(`${s}秒`)
  return parts.join('')
}

function parseCount (value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null
}

function formatJaMyriad (n) {
  const oku = Math.floor(n / 100000000)
  const man = Math.floor((n % 100000000) / 10000)
  const rem = n % 10000
  const parts = []
  if (oku) parts.push(`${oku.toLocaleString('en-US')}億`)
  if (man) parts.push(`${man.toLocaleString('en-US')}万`)
  if (rem) parts.push(rem.toLocaleString('en-US'))
  return parts.join('') || '0'
}

function formatCount (value, unit = '') {
  const n = parseCount(value)
  if (n === null) return null
  const comma = `${n.toLocaleString('en-US')}${unit}`
  return n >= 10000 ? `${comma}（${formatJaMyriad(n)}${unit}）` : comma
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

function formatJstDate (input) {
  if (input === null || input === undefined || input === '') return null
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return null
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10)
}

function formatJstIso (input) {
  if (input === null || input === undefined || input === '') return null
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return null
  return `${new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`
}

function toVideo (v) {
  return {
    id: v.id,
    channelId: v.snippet?.channelId || null,
    channelTitle: v.snippet?.channelTitle || null,
    title: v.snippet.title,
    description: (v.snippet.description || '').slice(0, MAX_DESCRIPTION),
    publishedAt: v.snippet.publishedAt,
    // none | upcoming | live
    liveStatus: v.snippet.liveBroadcastContent || 'none',
    scheduledStart: v.liveStreamingDetails?.scheduledStartTime || null,
    // Only streams have these: when it really started and ended.
    actualStart: v.liveStreamingDetails?.actualStartTime || null,
    actualEnd: v.liveStreamingDetails?.actualEndTime || null,
    isStream: !!v.liveStreamingDetails,
    thumbnail: v.snippet.thumbnails?.maxres?.url || v.snippet.thumbnails?.high?.url || v.snippet.thumbnails?.medium?.url || null,
    duration: v.contentDetails?.duration || null,
    viewCount: parseCount(v.statistics?.viewCount),
    likeCount: parseCount(v.statistics?.likeCount),
    commentCount: parseCount(v.statistics?.commentCount),
    url: `https://www.youtube.com/watch?v=${v.id}`
  }
}

// Walks the uploads playlist from `startToken` (newest first when absent). Without a start token it
// stops at the first page whose videos are all in `knownIds`: everything older is stored already.
// Returns the videos read, the pages used, and `nextToken` if it stopped at the page limit with
// more left (where a later read should continue), or null.
async function readUploads (playlistId, apiKey, { startToken = null, knownIds = new Set(), maxPages }) {
  const videos = []
  let pageToken = startToken
  for (let page = 0; page < maxPages; page++) {
    const playlist = await call('playlistItems', {
      part: 'contentDetails',
      playlistId,
      maxResults: String(PAGE_SIZE),
      ...(pageToken ? { pageToken } : {})
    }, apiKey)
    const ids = (playlist.items || []).map(i => i.contentDetails.videoId)
    if (ids.length !== 0) {
      const details = await call('videos', { part: 'snippet,contentDetails,liveStreamingDetails,statistics', id: ids.join(',') }, apiKey)
      videos.push(...(details.items || []).map(toVideo))
    }
    pageToken = playlist.nextPageToken
    const allKnown = !startToken && ids.length !== 0 && ids.every(id => knownIds.has(id))
    if (!pageToken || allKnown) return { videos, pages: page + 1, nextToken: null }
  }
  return { videos, pages: maxPages, nextToken: pageToken }
}

// The channel itself (1 quota unit). Throws with a hint when it does not exist.
async function resolveChannel (ref, apiKey) {
  const channels = await call('channels', {
    part: 'snippet,contentDetails,statistics',
    ...(ref.id ? { id: ref.id } : { forHandle: ref.handle })
  }, apiKey)
  const channel = channels.items?.[0]
  if (!channel) throw new YouTubeError(`YouTube channel not found: ${JSON.stringify(ref)}`, 'YouTube チャンネルが見つかりませんでした')
  return channel
}

// Reads the channel and its uploads: what is new since the last read (the newest page is always
// re-read, refreshing upcoming and live streams), then, if an earlier read stopped at the page
// limit, older videos from where it stopped (`backfillToken`). With nothing known yet that is the
// whole channel, MAX_PAGES at a time. Returns { channel, videos, backfillToken } where
// backfillToken is where the next read should continue, or null when every video has been read.
async function fetchChannelKnowledge (ref, apiKey, { knownIds = new Set(), backfillToken = null, maxPages = MAX_PAGES } = {}) {
  const channel = await resolveChannel(ref, apiKey)
  const uploads = channel.contentDetails?.relatedPlaylists?.uploads
  const videos = []
  let nextBackfill = backfillToken
  if (uploads) {
    const newest = await readUploads(uploads, apiKey, { knownIds, maxPages })
    videos.push(...newest.videos)
    if (newest.nextToken) {
      // So much is new that the limit cut it; continue from here next time.
      nextBackfill = newest.nextToken
    } else if (backfillToken && newest.pages < maxPages) {
      const older = await readUploads(uploads, apiKey, { startToken: backfillToken, maxPages: maxPages - newest.pages })
      videos.push(...older.videos)
      nextBackfill = older.nextToken
    }
  }
  return {
    channel: {
      id: channel.id,
      title: channel.snippet.title,
      description: (channel.snippet.description || '').slice(0, MAX_DESCRIPTION),
      handle: channel.snippet.customUrl || null,
      subscriberCount: channel.statistics?.hiddenSubscriberCount ? null : parseCount(channel.statistics?.subscriberCount),
      viewCount: parseCount(channel.statistics?.viewCount),
      url: `https://www.youtube.com/channel/${channel.id}`
    },
    videos,
    backfillToken: nextBackfill
  }
}

// The current state of videos by ID, PAGE_SIZE per call (1 quota unit each). Videos that are gone
// (deleted or made private) are simply missing from the result.
async function fetchVideos (ids, apiKey) {
  const videos = []
  for (let i = 0; i < ids.length; i += PAGE_SIZE) {
    const details = await call('videos', { part: 'snippet,contentDetails,liveStreamingDetails,statistics', id: ids.slice(i, i + PAGE_SIZE).join(',') }, apiKey)
    videos.push(...(details.items || []).map(toVideo))
  }
  return videos
}

module.exports = { parseChannelRef, parseVideoId, parseVideoIds, resolveChannel, fetchChannelKnowledge, fetchVideos, toVideo, YouTubeError, MAX_PAGES, linkTimestamps, durationSeconds, formatDuration, parseCount, formatCount, formatJstDate, formatJstIso }
