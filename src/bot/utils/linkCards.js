// The links in a chat reply: written in the text as [題名](URL), with the YouTube videos it links
// to shown as cards (embeds) under it, made by the bot, so the reply is not a wall of long URLs.
// Discord's own previews of the links are turned off (<URL>), so a video does not appear twice and
// each timestamp link does not get a preview of its own.
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const { parseVideoId } = require('./youtube')

const MAX_CARDS = 4
const MAX_CONTENT = 2000
const YOUTUBE_RED = 0xFF0000
const OEMBED_TIMEOUT_MS = 5000

// Bare URLs, and the URL part of [text](URL) / [text](<URL>).
const MASKED = /\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)/g
const BARE = /(?<![(<\w])https?:\/\/[^\s<>()]+[^\s<>().,!?、。！？」』]/g

// The title and channel of a video not stored: YouTube's oEmbed, which needs no key. null when
// it cannot be read.
async function oembed (videoID, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoID}`)}`, { signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS) })
    if (!res.ok) return null
    const data = await res.json()
    return { title: data.title || null, channel_title: data.author_name || null }
  } catch (_) {
    return null
  }
}

async function videoInfo (ids, fetchImpl) {
  const stored = new Map((await youtubeDB.videoCards(ids).catch(() => [])).map(v => [v.video_id, v]))
  const info = new Map()
  for (const id of ids) info.set(id, stored.get(id) || await oembed(id, fetchImpl) || {})
  return info
}

function card (videoID, { title, channel_title: channel } = {}) {
  const url = `https://www.youtube.com/watch?v=${videoID}`
  return {
    title: String(title || 'YouTube の動画').slice(0, 256),
    url,
    ...(channel ? { author: { name: String(channel).slice(0, 256) } } : {}),
    thumbnail: { url: `https://i.ytimg.com/vi/${videoID}/hqdefault.jpg` },
    color: YOUTUBE_RED
  }
}

// { content, embeds } for the reply `text`.
async function withLinkCards (text, { fetchImpl } = {}) {
  const urls = [...text.matchAll(MASKED)].map(m => m[2]).concat(text.replace(MASKED, '').match(BARE) || [])
  const ids = [...new Set(urls.map(parseVideoId).filter(Boolean))].slice(0, MAX_CARDS)
  const info = ids.length ? await videoInfo(ids, fetchImpl) : new Map()
  const label = url => {
    const id = parseVideoId(url)
    return (id && info.get(id)?.title) || null
  }
  let content = text
    .replace(MASKED, (whole, name, url) => `[${name}](<${url}>)`)
    // A bare video link gets its title; any other bare link keeps its URL, without a preview.
    .replace(BARE, url => label(url) ? `[${label(url).replace(/[[\]]/g, '')}](<${url}>)` : `<${url}>`)
  if (content.length > MAX_CONTENT) content = `${content.slice(0, MAX_CONTENT - 1)}…`
  return { content, embeds: ids.map(id => card(id, info.get(id))) }
}

module.exports = { withLinkCards }
