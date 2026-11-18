// Fetches and cleans public Japanese captions (manual or auto-generated) from YouTube watch
// pages for speaking-style corpus extraction (streamerStyle.js). Results are cached per video ID
// in Redis (aiCache) so each video is fetched at most once a month, and any network or YouTube
// layout change degrades silently to empty results (falling back to quoted speech in stored
// video summaries).
const aiCache = require('./aiCache')
const { decodeEntities } = require('./urlFetcher')
const { durationSeconds } = require('./youtube')
const { looksLikeInjection } = require('./untrusted')
const { isUnsafeMinorContent } = require('./minorSafety')

const CACHE_PREFIX = 'yt-captions:v1:'
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
const NEGATIVE_CACHE_TTL_SECONDS = 3 * 24 * 60 * 60
const FETCH_TIMEOUT_MS = 10 * 1000
const VIDEO_ID_RE = /^[\w-]{11}$/
const SOUND_TAG_RE = /\[(?:音楽|拍手|笑い|歓声|bgm|music|applause|laughter)\]|♪+/giu
const ALLOWED_CAPTION_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com'])

function isAllowedCaptionUrl (rawUrl) {
  try {
    const u = new URL(rawUrl)
    return u.protocol === 'https:' && ALLOWED_CAPTION_HOSTS.has(u.hostname.toLowerCase())
  } catch (_) {
    return false
  }
}

// Balanced-brace extraction of `ytInitialPlayerResponse = { ... }` from watch page HTML.
function extractPlayerResponse (html) {
  const src = String(html || '')
  const match = /(?:var\s+ytInitialPlayerResponse|window\s*\[\s*['"]ytInitialPlayerResponse['"]\s*\]|ytInitialPlayerResponse)\s*=\s*\{/.exec(src)
  if (!match) return null
  const start = match.index + match[0].length - 1
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(src.slice(start, i + 1))
        } catch (_) {
          return null
        }
      }
    }
  }
  return null
}

// Prefers Japanese manual captions over Japanese auto-generated (asr) captions.
function pickJapaneseTrack (playerResponse) {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks
  if (!Array.isArray(tracks) || !tracks.length) return null
  const ja = tracks.filter(t => /^ja(?:$|[-_])/i.test(String(t?.languageCode || '')) && isAllowedCaptionUrl(t?.baseUrl))
  if (!ja.length) return null
  const chosen = ja.find(t => t.kind !== 'asr') || ja[0]
  return {
    baseUrl: chosen.baseUrl,
    isAuto: chosen.kind === 'asr',
    languageCode: chosen.languageCode
  }
}

function cleanCueText (raw) {
  return decodeEntities(String(raw || ''))
    .replace(SOUND_TAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseJson3Captions (data) {
  const events = Array.isArray(data?.events) ? data.events : []
  const cues = []
  for (const ev of events) {
    if (!Array.isArray(ev?.segs)) continue
    const text = cleanCueText(ev.segs.map(s => s?.utf8 || '').join(''))
    if (!text) continue
    cues.push({
      startMs: Number(ev.tStartMs) || 0,
      durMs: Number(ev.dDurationMs) || 0,
      text
    })
  }
  return cues
}

function parseXmlCaptions (xml) {
  const src = String(xml || '')
  const cues = []
  const textTagRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi
  for (const m of src.matchAll(textTagRe)) {
    const attrs = m[1]
    const startSec = Number(attrs.match(/\bstart="([^"]+)"/i)?.[1] || 0)
    const durSec = Number(attrs.match(/\bdur="([^"]+)"/i)?.[1] || 0)
    const text = cleanCueText(m[2].replace(/<[^>]+>/g, ''))
    if (!text) continue
    cues.push({
      startMs: Math.round(startSec * 1000),
      durMs: Math.round(durSec * 1000),
      text
    })
  }
  if (cues.length) return cues
  const pTagRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi
  for (const m of src.matchAll(pTagRe)) {
    const attrs = m[1]
    const startMs = Number(attrs.match(/\bt="([^"]+)"/i)?.[1] || 0)
    const durMs = Number(attrs.match(/\bd="([^"]+)"/i)?.[1] || 0)
    const text = cleanCueText(m[2].replace(/<[^>]+>/g, ''))
    if (!text) continue
    cues.push({ startMs, durMs, text })
  }
  return cues
}

function cleanSpokenChunk (raw) {
  const s = String(raw || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  const plain = s.replace(/[\s\p{P}\p{S}]/gu, '')
  if ([...plain].length < 10) return ''
  if (looksLikeInjection(s) || isUnsafeMinorContent(s)) return ''
  return s.slice(0, 150)
}

// Merges consecutive timedtext cues into natural spoken turns and samples evenly across the video
// so the corpus captures ongoing commentary and reactions rather than just the opening greeting.
function buildSpokenUtterances (cues, { maxUtterances = 20 } = {}) {
  if (!Array.isArray(cues) || !cues.length) return []
  const chunks = []
  let buf = ''
  let prevEndMs = null

  const flush = () => {
    const cleaned = cleanSpokenChunk(buf)
    if (cleaned) chunks.push(cleaned)
    buf = ''
  }

  for (const cue of cues) {
    const piece = cleanCueText(cue?.text)
    if (!piece) continue
    const startMs = Number(cue.startMs) || 0
    const durMs = Number(cue.durMs) || 0
    const gap = prevEndMs === null ? 0 : startMs - prevEndMs
    if (buf && (gap >= 1200 || /[。！？!?]$/.test(buf) || [...buf].length >= 70)) {
      flush()
    }
    buf = buf ? `${buf}${/[a-z0-9]$/i.test(buf) && /^[a-z0-9]/i.test(piece) ? ' ' : ''}${piece}` : piece
    prevEndMs = startMs + durMs
  }
  flush()

  const unique = [...new Set(chunks)]
  if (unique.length <= maxUtterances) return unique
  return Array.from({ length: maxUtterances }, (_, i) => unique[Math.floor(i * unique.length / maxUtterances)])
}

// Fallback when public captions are unavailable: extracts quoted direct speech (`「...」`) from
// already-stored Gemini video summaries so zero extra API calls are spent.
function extractQuotedSpeechFromSummary (summary, { maxQuotes = 6 } = {}) {
  const out = []
  const seen = new Set()
  for (const m of String(summary || '').matchAll(/「([^「」\n]{8,120})」/g)) {
    const cleaned = cleanSpokenChunk(m[1])
    if (!cleaned || seen.has(cleaned)) continue
    seen.add(cleaned)
    out.push(cleaned)
    if (out.length >= maxQuotes) break
  }
  return out
}

// Picks recent completed videos most likely to carry clean solo/commentary captions: prefers
// standard 2-minute to 2-hour videos ahead of shorts or multi-hour marathons.
function selectVideosForCaptions (videos, maxVideos = 4) {
  const valid = (videos || []).filter(v => VIDEO_ID_RE.test(String(v?.video_id || '')))
  const preferred = []
  const fallback = []
  for (const v of valid) {
    const sec = durationSeconds(v.duration)
    if (sec !== null && sec >= 120 && sec <= 7200) preferred.push(v)
    else fallback.push(v)
  }
  return [...preferred, ...fallback].slice(0, maxVideos)
}

async function fetchVideoCaptions (videoID, { fetchImpl = fetch, cache = aiCache, maxUtterances = 18 } = {}) {
  if (!VIDEO_ID_RE.test(String(videoID || ''))) return { utterances: [], isAuto: false, source: 'none' }
  const key = `${CACHE_PREFIX}${videoID}`
  const cached = await cache.getJson(key)
  if (cached && Array.isArray(cached.utterances)) {
    return { utterances: cached.utterances, isAuto: Boolean(cached.isAuto), source: cached.utterances.length ? 'captions' : 'none' }
  }

  try {
    const headers = {
      'User-Agent': 'RoboPolice (+https://github.com/waxsd100/RoboPolice)',
      'Accept-Language': 'ja-JP,ja;q=0.9'
    }
    const watchRes = await fetchImpl(`https://www.youtube.com/watch?v=${videoID}&hl=ja`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!watchRes.ok) {
      return { utterances: [], isAuto: false, source: 'none' }
    }
    const player = extractPlayerResponse(await watchRes.text())
    const track = pickJapaneseTrack(player)
    if (!track) {
      await cache.setJson(key, { utterances: [], isAuto: false, unavailable: true }, NEGATIVE_CACHE_TTL_SECONDS)
      return { utterances: [], isAuto: false, source: 'none' }
    }

    const captionUrl = new URL(track.baseUrl)
    captionUrl.searchParams.set('fmt', 'json3')
    const capRes = await fetchImpl(captionUrl.toString(), {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!capRes.ok) {
      return { utterances: [], isAuto: track.isAuto, source: 'none' }
    }
    const body = await capRes.text()
    let cues = []
    if (body.trimStart().startsWith('{')) {
      try { cues = parseJson3Captions(JSON.parse(body)) } catch (_) {}
    }
    if (!cues.length) cues = parseXmlCaptions(body)
    const utterances = buildSpokenUtterances(cues, { maxUtterances })
    await cache.setJson(
      key,
      { utterances, isAuto: track.isAuto, unavailable: utterances.length === 0 },
      utterances.length ? CACHE_TTL_SECONDS : NEGATIVE_CACHE_TTL_SECONDS
    )
    return { utterances, isAuto: track.isAuto, source: utterances.length ? 'captions' : 'none' }
  } catch (_) {
    return { utterances: [], isAuto: false, source: 'none' }
  }
}

module.exports = {
  extractPlayerResponse,
  pickJapaneseTrack,
  parseJson3Captions,
  parseXmlCaptions,
  buildSpokenUtterances,
  extractQuotedSpeechFromSummary,
  selectVideosForCaptions,
  fetchVideoCaptions,
  CACHE_PREFIX
}
