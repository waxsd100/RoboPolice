// Knowledge learned from the streamer's YouTube videos (YOUTUBE_CHANNELS): every video with a
// stored summary, plus recent finished videos without a summary via their public Japanese captions.
// Video descriptions (`概要欄`) are intentionally excluded because YouTube descriptions are mostly
// copy-pasted channel templates that would skew fact extraction and embeddings.
// Written as pages of the unified knowledge tables with source = 'youtube' (youtubeKnowledge.js in
// Postgres), so wikiKnowledge.js extracts characters, quotes, projects, trivia and running jokes
// from actual video content and embeds both the sections and the extracted facts for
// `describeServer` (コミュニティの知識) and `search_wiki`.
const { knowledgeSetting } = require('../utils/knowledgeDefaults')
const { cleanSummary } = require('../utils/textClean')
const { looksLikeInjection } = require('../utils/untrusted')
const { isUnsafeMinorContent, sanitizeUntrustedLines } = require('../utils/minorSafety')
const youtubeCaptions = require('../utils/youtubeCaptions')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const { hashOf } = require('../../db/interfaces/postgres/wiki')
const store = require('../../db/interfaces/postgres/youtubeKnowledge')

const WATCH_PREFIX = 'https://www.youtube.com/watch?v='
const MAX_SECTION_CHARS = 1500
const DEFAULT_CAPTION_VIDEOS = 25
const MAX_CAPTION_VIDEOS = 100
const CAPTION_MAX_UTTERANCES = 35
const DEFAULT_CAPTION_DELAY_MS = 300

// Recurring spoken intro/outro calls-to-action in captions carry no video-specific knowledge.
const SPOKEN_PROMO_RE = /(?:チャンネル登録|高評価|グッドボタン|概要欄のリンク|メンバーシップ登録|提供でお送り)/iu

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function configuredChannels () {
  return String(knowledgeSetting('YOUTUBE_CHANNELS')).split(',').map(s => s.trim()).filter(Boolean)
}

function enabled () {
  return configuredChannels().length !== 0
}

function captionVideoLimit () {
  const raw = process.env.YOUTUBE_KNOWLEDGE_CAPTION_VIDEOS
  if (raw === undefined || raw === '') return DEFAULT_CAPTION_VIDEOS
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_CAPTION_VIDEOS) : DEFAULT_CAPTION_VIDEOS
}

function captionDelayMs () {
  const raw = process.env.YOUTUBE_CAPTION_DELAY_MS
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_CAPTION_DELAY_MS
}

const urlOf = videoID => `${WATCH_PREFIX}${videoID}`

function titleOf (video) {
  const base = String(video?.title || video?.video_id || '').trim()
  return `${base}（YouTube 動画）`
}

function dayOf (date) {
  if (!date) return ''
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(d)
}

// Splits `text` along line breaks so each part stays <= `maxChars` without slicing lines in half.
function splitTextParts (text, maxChars = MAX_SECTION_CHARS) {
  const src = String(text || '').trim()
  if (!src) return []
  if (src.length <= maxChars) return [src]
  const out = []
  let current = ''
  for (const rawLine of src.split('\n')) {
    const line = rawLine.length > maxChars ? rawLine.slice(0, maxChars) : rawLine
    if (current && `${current}\n${line}`.length > maxChars) {
      out.push(current.trim())
      current = line
    } else {
      current = current ? `${current}\n${line}` : line
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

// Builds knowledge_sections entries `[{ heading, text, images }]` for one video from its actual
// spoken/visual content (stored summary or public captions), never from `video.description`.
// Returns `[]` when an unsummarized video has no usable captions.
function buildVideoSections (video, { utterances = [] } = {}) {
  if (!video?.video_id) return []
  const meta = []
  const published = dayOf(video.published_at)
  if (published) meta.push(`公開日: ${published}`)
  if (video.channel_title) meta.push(`チャンネル: ${video.channel_title}`)
  const header = meta.length ? `${meta.join(' / ')}\n` : ''

  const summary = video.summary ? sanitizeUntrustedLines(cleanSummary(video.summary) || video.summary).trim() : ''
  if (summary) {
    const parts = splitTextParts(`${header}動画の内容（時系列記録）:\n${summary}`, MAX_SECTION_CHARS)
      .filter(t => !looksLikeInjection(t) && !isUnsafeMinorContent(`${video.title || ''}\n${t}`))
    return parts.map((text, i) => ({
      heading: parts.length === 1 ? '動画の内容' : `動画の内容 ${i + 1}`,
      text,
      images: []
    }))
  }

  const cleanUtterances = (Array.isArray(utterances) ? utterances : [])
    .map(u => String(u || '').trim())
    .filter(u => u && !SPOKEN_PROMO_RE.test(u) && !looksLikeInjection(u) && !isUnsafeMinorContent(u))
  if (!cleanUtterances.length) return []

  const body = `${header}字幕からの抜粋（自動音声認識を含む場合あり）:\n${cleanUtterances.map(u => `- ${u}`).join('\n')}`
  const parts = splitTextParts(body, MAX_SECTION_CHARS)
    .filter(t => !looksLikeInjection(t) && !isUnsafeMinorContent(`${video.title || ''}\n${t}`))
  return parts.map((text, i) => ({
    heading: parts.length === 1 ? '動画の字幕' : `動画の字幕 ${i + 1}`,
    text,
    images: []
  }))
}

const sectionHashesOf = sections => sections.map(s => hashOf(`${s.heading}\n${s.text}`))

function hashesEqual (a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((h, i) => h === b[i])
}

async function readExistingHashes () {
  if (typeof store.pageSectionHashes !== 'function') return new Map()
  return store.pageSectionHashes().catch(() => new Map())
}

// Updates or creates the knowledge page for a single stored followed-channel video (e.g. right
// after `videoSummary.storeSummary` finishes). External videos (`channel_id IS NULL`) return 0.
async function ingestVideo (videoID, { runPending = true, fetchCaptions = youtubeCaptions.fetchVideoCaptions, log = m => global.logger.warn(m) } = {}) {
  if (!enabled() || !videoID || typeof youtubeDB.getVideo !== 'function') return 0
  const video = await youtubeDB.getVideo(videoID).catch(() => null)
  if (!video || !video.channel_id) return 0
  const url = urlOf(video.video_id)
  const existing = await readExistingHashes()
  let utterances = []
  if (!video.summary) {
    if (existing.has(url)) return 0
    const cap = await fetchCaptions(video.video_id, { maxUtterances: CAPTION_MAX_UTTERANCES }).catch(() => ({ utterances: [] }))
    utterances = cap?.utterances || []
  }
  const sections = buildVideoSections(video, { utterances })
  if (!sections.length) return 0
  if (hashesEqual(existing.get(url), sectionHashesOf(sections))) return 0
  await store.savePage(url, titleOf(video), sections)
  if (runPending) {
    await require('./wikiKnowledge').processPending(log).catch(e => log(`[YOUTUBE-KNOWLEDGE]: ${e.message}`))
  }
  return sections.length
}

function onSummarySaved (videoID) {
  if (!enabled() || !videoID) return
  ingestVideo(videoID).catch(e => global.logger.warn(`[YOUTUBE-KNOWLEDGE]: Could not ingest ${videoID}: ${e.message}`))
}

let running = false
async function refresh ({ force = false, fetchCaptions = youtubeCaptions.fetchVideoCaptions, delayMs = captionDelayMs(), log = m => global.logger.warn(m) } = {}) {
  if (running || !enabled() || typeof youtubeDB.videosForKnowledge !== 'function') return 0
  running = true
  try {
    const unsummarizedLimit = captionVideoLimit()
    const [candidates, existing, allIds] = await Promise.all([
      youtubeDB.videosForKnowledge({ unsummarizedLimit }),
      readExistingHashes(),
      typeof youtubeDB.getVideoIds === 'function' ? youtubeDB.getVideoIds().catch(() => null) : Promise.resolve(null)
    ])

    let saved = 0
    let fetchedCaptionCount = 0
    for (const video of candidates) {
      if (!video?.video_id || !video.channel_id) continue
      const url = urlOf(video.video_id)
      try {
        let utterances = []
        if (!video.summary) {
          if (!force && existing.has(url)) continue
          if (fetchedCaptionCount > 0 && delayMs > 0) await sleep(delayMs)
          const cap = await fetchCaptions(video.video_id, { maxUtterances: CAPTION_MAX_UTTERANCES }).catch(() => ({ utterances: [] }))
          utterances = cap?.utterances || []
          fetchedCaptionCount++
        }
        const sections = buildVideoSections(video, { utterances })
        if (!sections.length) continue
        if (!force && hashesEqual(existing.get(url), sectionHashesOf(sections))) continue
        await store.savePage(url, titleOf(video), sections)
        saved++
      } catch (e) {
        log(`[YOUTUBE-KNOWLEDGE]: Could not save ${video.video_id}: ${e.message}`)
      }
    }

    // Drop knowledge pages only for videos whose channel is no longer followed; keep older
    // caption-derived pages of still-followed channels even after newer uploads push them past `unsummarizedLimit`.
    if (allIds && allIds.size > 0) {
      const validUrls = [...allIds].map(urlOf)
      await store.deletePagesExcept(WATCH_PREFIX, validUrls).catch(() => {})
    }
    if (saved) global.logger.info(`[YOUTUBE-KNOWLEDGE]: Updated ${saved} video knowledge page(s)`)
    return saved
  } finally {
    running = false
  }
}

module.exports = {
  WATCH_PREFIX,
  configuredChannels,
  enabled,
  captionVideoLimit,
  splitTextParts,
  buildVideoSections,
  ingestVideo,
  onSummarySaved,
  refresh
}
