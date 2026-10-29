// Reads a YouTube channel and its recent videos with the YouTube Data API v3. Every call used here
// costs 1 quota unit, so a sync costs 3-4 units.
const API = 'https://www.googleapis.com/youtube/v3'
const MAX_VIDEOS = 50 // one page of the uploads playlist; videos.list also takes at most 50 IDs
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

async function fetchChannelKnowledge (ref, apiKey) {
  const channels = await call('channels', {
    part: 'snippet,contentDetails',
    ...(ref.id ? { id: ref.id } : { forHandle: ref.handle })
  }, apiKey)
  const channel = channels.items?.[0]
  if (!channel) throw new YouTubeError(`YouTube channel not found: ${JSON.stringify(ref)}`, 'YouTube チャンネルが見つかりませんでした')

  const uploads = channel.contentDetails?.relatedPlaylists?.uploads
  const playlist = uploads
    ? await call('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: String(MAX_VIDEOS) }, apiKey)
    : { items: [] }
  const ids = (playlist.items || []).map(i => i.contentDetails.videoId)
  const videos = ids.length === 0
    ? { items: [] }
    : await call('videos', { part: 'snippet,contentDetails,liveStreamingDetails', id: ids.join(',') }, apiKey)

  return {
    channel: {
      id: channel.id,
      title: channel.snippet.title,
      description: (channel.snippet.description || '').slice(0, MAX_DESCRIPTION),
      handle: channel.snippet.customUrl || null,
      url: `https://www.youtube.com/channel/${channel.id}`
    },
    videos: (videos.items || []).map(toVideo)
  }
}

module.exports = { parseChannelRef, fetchChannelKnowledge, YouTubeError, MAX_VIDEOS }
