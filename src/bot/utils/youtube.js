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

// The video ID in a YouTube link: watch?v=, youtu.be/, /shorts/, /live/ and /embed/.
function parseVideoId (input) {
  const text = String(input || '').trim()
  const match = text.match(/(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})(?![\w-])/)
  return match ? match[1] : null
}

function toVideo (v) {
  return {
    id: v.id,
    title: v.snippet.title,
    description: (v.snippet.description || '').slice(0, MAX_DESCRIPTION),
    publishedAt: v.snippet.publishedAt,
    // none | upcoming | live
    liveStatus: v.snippet.liveBroadcastContent || 'none',
    scheduledStart: v.liveStreamingDetails?.scheduledStartTime || null,
    duration: v.contentDetails?.duration || null,
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
      const details = await call('videos', { part: 'snippet,contentDetails,liveStreamingDetails', id: ids.join(',') }, apiKey)
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
    part: 'snippet,contentDetails',
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
      url: `https://www.youtube.com/channel/${channel.id}`
    },
    videos,
    backfillToken: nextBackfill
  }
}

module.exports = { parseChannelRef, parseVideoId, resolveChannel, fetchChannelKnowledge, YouTubeError, MAX_PAGES }
