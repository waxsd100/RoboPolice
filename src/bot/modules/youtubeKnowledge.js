// Knowledge learned from the streamer's YouTube videos (YOUTUBE_CHANNELS): every video with a
// stored summary, plus recent finished videos without a summary via their public Japanese captions
// and non-boilerplate descriptions. Written as pages of the unified knowledge tables with
// source = 'youtube' (youtubeKnowledge.js in Postgres), so wikiKnowledge.js extracts characters,
// quotes, projects, trivia and running jokes from videos and embeds both the sections and the
// extracted facts for `describeServer` (コミュニティの知識) and `search_wiki`.
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
const MAX_DESCRIPTION_CHARS = 1000
const MIN_STANDALONE_DESC_CHARS = 40
const MIN_ACCOMPANYING_DESC_CHARS = 15
const DEFAULT_CAPTION_VIDEOS = 25
const MAX_CAPTION_VIDEOS = 100
const CAPTION_MAX_UTTERANCES = 35
const DEFAULT_CAPTION_DELAY_MS = 300

const DIVIDER_LINE_RE = /^[=\-*_━─▼▲◆◇■□★☆●○〜~#・\s]{3,}$/u
const BARE_URL_LINE_RE = /^https?:\/\/\S+$/i
const PROMO_PREFIX_RE = /^(?:チャンネル登録|高評価|グッドボタン|メンバーシップ|サブチャンネル|メインチャンネル|再生リスト|おすすめ動画|前回の動画|次回の動画|関連動画|Twitter|X\s*[（(]?旧?\s*Twitter|Twitch|Instagram|TikTok|LINE|Discord|グッズ|スタンプ|ほしい物リスト|干し芋)/iu
const CREDIT_LINE_RE = /^(?:BGM|SE|効果音|音楽|楽曲|使用楽曲|音源|素材|フリー素材|イラスト|立ち絵|エンディング|オープニング|ED|OP)\s*[:：]/iu
const CREDIT_SITE_RE = /(?:DOVA-SYNDROME|魔王魂|効果音ラボ|OtoLogic|甘茶の音楽工房|MusMus|ポケットサウンド|ニコニ・コモンズ|いらすとや)/iu
const AGENCY_FOOTER_RE = /(?:UUUM株式会社|ビジネス関係のお問い合わせ|ファンレター|プレゼント送付先|お問い合わせはこちら|提供[:：])/iu
const MULTI_HASHTAG_LINE_RE = /^(?:#\S+\s*){2,}$/u

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

// Strips recurring YouTube description boilerplate (subscribe links, social handles, BGM/SE
// credits, agency footers, decorative dividers) while keeping video-specific explanations.
function cleanVideoDescription (raw) {
  const safe = sanitizeUntrustedLines(String(raw || ''))
  if (!safe) return ''
  const kept = []
  for (const rawLine of safe.split('\n')) {
    const line = rawLine.trim()
    if (!line) {
      if (kept.length && kept[kept.length - 1] !== '') kept.push('')
      continue
    }
    if (DIVIDER_LINE_RE.test(line) || BARE_URL_LINE_RE.test(line) || MULTI_HASHTAG_LINE_RE.test(line)) continue
    if (PROMO_PREFIX_RE.test(line) || CREDIT_LINE_RE.test(line) || CREDIT_SITE_RE.test(line) || AGENCY_FOOTER_RE.test(line)) continue
    const withoutUrls = line.replace(/https?:\/\/\S+/gi, '').trim()
    const plain = withoutUrls.replace(/[#@]\S+|[\s\p{P}\p{S}]/gu, '')
    if ([...plain].length < 4) continue
    if (looksLikeInjection(withoutUrls) || isUnsafeMinorContent(withoutUrls)) continue
    kept.push(withoutUrls)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_DESCRIPTION_CHARS)
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

// Builds knowledge_sections entries `[{ heading, text, images }]` for one video, or `[]` when an
// unsummarized video has neither captions nor a substantive description.
function buildVideoSections (video, { utterances = [] } = {}) {
  if (!video?.video_id) return []
  const meta = []
  const published = dayOf(video.published_at)
  if (published) meta.push(`公開日: ${published}`)
  if (video.channel_title) meta.push(`チャンネル: ${video.channel_title}`)
  const header = meta.length ? `${meta.join(' / ')}\n` : ''
  const desc = cleanVideoDescription(video.description)

  const summary = video.summary ? sanitizeUntrustedLines(cleanSummary(video.summary) || video.summary).trim() : ''
  if (summary) {
    const blocks = []
    if ([...desc].length >= MIN_ACCOMPANYING_DESC_CHARS) blocks.push(`概要欄:\n${desc}`)
    blocks.push(`動画の内容（時系列記録）:\n${summary}`)
    const parts = splitTextParts(`${header}${blocks.join('\n\n')}`, MAX_SECTION_CHARS)
      .filter(t => !looksLikeInjection(t) && !isUnsafeMinorContent(`${video.title || ''}\n${t}`))
    return parts.map((text, i) => ({
      heading: parts.length === 1 ? '動画の内容' : `動画の内容 ${i + 1}`,
      text,
      images: []
    }))
  }

  const cleanUtterances = (Array.isArray(utterances) ? utterances : [])
    .map(u => String(u || '').trim())
    .filter(u => u && !looksLikeInjection(u) && !isUnsafeMinorContent(u))
  if (!cleanUtterances.length && [...desc].length < MIN_STANDALONE_DESC_CHARS) return []

  const blocks = []
  if ([...desc].length >= MIN_ACCOMPANYING_DESC_CHARS) blocks.push(`概要欄:\n${desc}`)
  if (cleanUtterances.length) {
    blocks.push(`字幕からの抜粋（自動音声認識を含む場合あり）:\n${cleanUtterances.map(u => `- ${u}`).join('\n')}`)
  }
  const parts = splitTextParts(`${header}${blocks.join('\n\n')}`, MAX_SECTION_CHARS)
    .filter(t => !looksLikeInjection(t) && !isUnsafeMinorContent(`${video.title || ''}\n${t}`))
  return parts.map((text, i) => ({
    heading: parts.length === 1 ? '字幕・概要欄' : `字幕・概要欄 ${i + 1}`,
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
  cleanVideoDescription,
  splitTextParts,
  buildVideoSections,
  ingestVideo,
  onSummarySaved,
  refresh
}
