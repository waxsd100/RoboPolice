// Reads a YouTube channel and its videos with the YouTube Data API v3. Every call used here costs 1
// quota unit: 1 for the channel plus 2 per page of 50 videos.
const API = 'https://www.googleapis.com/youtube/v3'
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
function parseChannelRef (input) {
  const text = String(input || '').trim()
  const id = text.match(/(?:^|\/channel\/)(UC[\w-]{22})(?:[/?#]|$)/)
  if (id) return { id: id[1] }
  const handle = text.match(/(?:^|youtube\.com\/)@([\w.-]{3,30})(?:[/?#]|$)/i)
  if (handle) return { handle: handle[1] }
  return null
}

async function call (path, params, apiKey) {
  const url = `${API}/${path}?${new URLSearchParams({ ...params, key: apiKey })}`
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
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

async function readUploads (playlistId, apiKey, knownIds, maxPages) {
  const videos = []
  let pageToken
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
    // A page of only known videos means everything older is stored already.
    if (!pageToken || (ids.length !== 0 && ids.every(id => knownIds.has(id)))) return { videos, complete: true }
  }
  return { videos, complete: false }
}

// Reads the channel and walks its uploads newest first, stopping after the first page whose videos
// are all in `knownIds`. The newest page is therefore always re-read (refreshing upcoming and live
// streams), and with nothing known yet the whole channel is read, up to MAX_PAGES. Returns
// { channel, videos, complete }; complete is false when MAX_PAGES cut the walk short.
async function fetchChannelKnowledge (ref, apiKey, { knownIds = new Set(), maxPages = MAX_PAGES } = {}) {
  const channels = await call('channels', {
    part: 'snippet,contentDetails',
    ...(ref.id ? { id: ref.id } : { forHandle: ref.handle })
  }, apiKey)
  const channel = channels.items?.[0]
  if (!channel) throw new YouTubeError(`YouTube channel not found: ${JSON.stringify(ref)}`, 'YouTube チャンネルが見つかりませんでした')

  const uploads = channel.contentDetails?.relatedPlaylists?.uploads
  const { videos, complete } = uploads
    ? await readUploads(uploads, apiKey, knownIds, maxPages)
    : { videos: [], complete: true }

  return {
    channel: {
      id: channel.id,
      title: channel.snippet.title,
      description: (channel.snippet.description || '').slice(0, MAX_DESCRIPTION),
      handle: channel.snippet.customUrl || null,
      url: `https://www.youtube.com/channel/${channel.id}`
    },
    videos,
    complete
  }
}

module.exports = { parseChannelRef, parseVideoId, fetchChannelKnowledge, YouTubeError, MAX_PAGES }
