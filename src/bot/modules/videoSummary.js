// Summarizes what is said and shown in a public YouTube video, by handing its URL to Gemini, and
// keeps the summary so the same video is never summarized twice. Only run when the
// model decides it needs a video's contents (a video was linked, or a question is about what a
// video says): it is far costlier than reading titles and descriptions.
const { callGemini, DEFAULT_GEMINI_MODEL, GeminiError, lightModel, resolveTaskConfig, retryTimer, thinkingConfig } = require('./eventDrafter')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const youtube = require('../utils/youtube')
const { parseVideoId, durationSeconds } = youtube
const { cleanSummary, fmtSeconds: fmt } = require('../utils/textClean')
const backgroundQueue = require('../utils/backgroundQueue')

const MAX_SUMMARY = 3000
// Gemini watches the whole video before answering, so an hour-long stream archive can take
// several minutes. VIDEO_SUMMARY_TIMEOUT_MINUTES overrides the default.
const DEFAULT_TIMEOUT_MINUTES = 10

function summaryTimeoutMs () {
  const minutes = Number(process.env.VIDEO_SUMMARY_TIMEOUT_MINUTES)
  return (minutes > 0 ? minutes : DEFAULT_TIMEOUT_MINUTES) * 60 * 1000
}

const PROMPT = [
  'この YouTube 動画の内容を、以下の固定テンプレートに従って日本語で記録してください（全体で最大1500文字程度まで）。',
  '',
  '【出力テンプレート（1行1項目・時系列順）】',
  '- [0:00] 行ったこと・起きたことと、その結果',
  '- [12:34] 次の出来事・話題と、その結果・結論',
  '- [1:05:00] 告知や決定事項があれば具体的内容（日時・場所・出演者・URLなど）',
  '',
  '【厳守事項】',
  '- 上の `- [時間] 内容` の箇条書き行だけを出力し、前置き（「要約しました！」「以下が要約です」など）・後書き（「以上です」など）・見出し・空行・感想・挨拶・文字数は一切書かないでください。',
  '- 時間は1時間未満なら `[分:秒]`（例: `[0:00]`, `[5:30]`）、1時間以上なら `[時:分:秒]`（例: `[1:05:00]`）で統一してください。',
  '- 太字（`**`）や番号付きリスト・入れ子の箇条書きは使わず、すべての行を `- [時間] ` で始めてください。',
  '- 「〜について話しています」のような冗長な表現は避け、何をしてどうなったか（結果・勝敗・達成状況・結論・告知の具体情報）だけを体言止めまたは簡潔な常体で淡々と書いてください。',
  '- 分からないことは推測で書かないでください。'
].join('\n')

const MERGE_PROMPT = [
  '次は1本の長い動画を時間帯ごとに分けて記録したものです。重複を整理し、動画全体で1つの時系列リストにまとめてください（全体で最大1500文字程度まで）。',
  '- 出力は `- [時間] 行ったこと・結果` の箇条書き行だけにし、前置き（「要約しました！」など）・後書き（「以上です」など）・見出し（`###` など）・空行・感想・文字数は一切書かないでください。',
  '- 各項目の先頭の `[時間]` は書き換えずにそのまま残し、太字（`**`）や番号付きリスト・入れ子の箇条書きは使わず、すべての行を `- [時間] ` で始めてください。',
  '- 出来事の結果・結論や、告知・日時・場所・出演者・URL などの具体的な情報は漏らさず残し、体言止めまたは簡潔な常体で淡々と書いてください。'
].join('\n')

// A video longer than Gemini can take in at once (about 3 hours at low resolution: its input is at
// most about a million tokens, and multi-hour YouTube URLs fail unclipped with HTTP 400
// "Request contains an invalid argument.") is summarized two hours at a time (one hour or 30 minutes
// if that is still too much), and the parts' summaries are then put together into one.
const PART_SECONDS = [2 * 60 * 60, 60 * 60, 30 * 60]
const MAX_SINGLE_SECONDS = PART_SECONDS[0]
const TOO_LONG = /input token count.*exceeds/i
const INVALID_VIDEO_ARG = /Request contains an invalid argument/i
const CLIP_RETRY_DELAY_MS = 2000

function canSplitError (message) {
  const text = String(message || '')
  return TOO_LONG.test(text) || INVALID_VIDEO_ARG.test(text)
}

// [分:秒] / [時:分:秒] written from the start of a part, moved to be from the start of the video.
function shiftTimestamps (text, offset) {
  if (!offset) return text
  return text.replace(/\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\]/g, (whole, h, m, s) => `[${fmt(offset + Number(h || 0) * 3600 + Number(m) * 60 + Number(s))}]`)
}

function partClips (seconds, partSeconds = MAX_SINGLE_SECONDS) {
  const clips = []
  for (let start = 0; start < seconds; start += partSeconds) {
    clips.push({ start, end: Math.min(seconds, start + partSeconds) })
  }
  if (clips.length > 1) {
    const last = clips[clips.length - 1]
    if (last.end - last.start < 60) {
      clips[clips.length - 2].end = last.end
      clips.pop()
    }
  }
  return clips
}

function partPrompt (start, end) {
  return `${PROMPT}\n\n※これは長い動画の ${fmt(start)}〜${fmt(end)} の区間だけです。この区間内の出来事と結果だけを同じ \`- [時間] 内容\` 形式のみで出力し、時間はこの区間の先頭を \`[0:00]\` として書いてください。`
}

function formatPartSummary (start, end, text) {
  return `### ${fmt(start)}〜${fmt(end)}\n${shiftTimestamps(cleanSummary(text), start)}`
}

// Frames a second Gemini looks at (VIDEO_SUMMARY_FPS, default 0.2: one every 5 seconds; Gemini's
// own default is 1). Each frame costs tokens while the sound is heard throughout, and a summary is
// mostly about what is said, so fewer frames cost much less for about the same summary.
const DEFAULT_FPS = 0.2
function fps () {
  const n = Number(process.env.VIDEO_SUMMARY_FPS)
  return process.env.VIDEO_SUMMARY_FPS && n > 0 && n <= 24 ? n : DEFAULT_FPS
}

const textOf = content => content.parts.map(p => p.text || '').join('').trim()

// The model and generateContent body that summarize a video (or the clip of it) with `prompt`.
function summaryRequest (videoID, prompt = PROMPT, clip = null, custom = null) {
  const model = custom?.model || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
  const thinking = custom?.thinking || thinkingConfig(model, { setting: 'VIDEO_SUMMARY_THINKING_LEVEL', fallback: 'low' })
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoID}` }, videoMetadata: { fps: fps(), ...(clip ? { startOffset: `${clip.start}s`, endOffset: `${clip.end}s` } : {}) } },
        { text: prompt }
      ]
    }],
    // Fewer tokens per frame: the summary is about what is said and roughly shown, not fine detail.
    // Gemini 3 thinks at high unless told: a summary needs little (VIDEO_SUMMARY_THINKING_LEVEL).
    generationConfig: { temperature: 0.2, mediaResolution: 'MEDIA_RESOLUTION_LOW', ...thinking }
  }
  // Video summaries keep the model's own safety filters (no safetySettings), also in a batch.
  return { model, body }
}

// flex: on Flex inference (half the price, queued for up to about 15 minutes more).
// Clipped YouTube URLs intermittently return a transient HTTP 400 INVALID_ARGUMENT on ingestion,
// so a clip is retried once before stepping down to smaller parts.
const FLEX_EXTRA_MS = 15 * 60 * 1000
async function askVideo (videoID, prompt, clip = null, { flex = false, guildID = null, retries = clip ? 1 : 0 } = {}) {
  const custom = guildID ? await resolveTaskConfig('summary', guildID) : null
  const { model, body } = summaryRequest(videoID, prompt, clip, custom)
  for (let attempt = 0; ; attempt++) {
    try {
      return await callGemini(model, body, {
        timeoutMs: summaryTimeoutMs() + (flex ? FLEX_EXTRA_MS : 0),
        purpose: flex ? 'videoSummary-flex' : 'videoSummary',
        flex,
        defaultSafety: true
      })
    } catch (e) {
      if (attempt >= retries || !INVALID_VIDEO_ARG.test(e.message)) throw e
      global.logger.info(`[SUMMARY]: Retrying ${videoID}${clip ? ` (${fmt(clip.start)}-${fmt(clip.end)})` : ''} after transient invalid-argument error`)
      await retryTimer.sleep(CLIP_RETRY_DELAY_MS * (attempt + 1))
    }
  }
}

// Stores `text` as the video's summary, asked for by the server. Resolves to the summary.
async function storeSummary (guildID, videoID, text) {
  const summary = cleanSummary(text).slice(0, MAX_SUMMARY)
  if (!summary) throw new GeminiError(`Gemini returned no summary for ${videoID}`, 'AI が動画を要約できませんでした')
  await youtubeDB.saveSummary(guildID, videoID, summary)
  return summary
}

// The video's length in seconds: as stored, or from the YouTube API. Null when unknown.
async function lengthOf (videoID) {
  const stored = durationSeconds(await youtubeDB.videoDuration(videoID).catch(() => null))
  if (stored) return stored
  if (!process.env.YOUTUBE_API_KEY) return null
  const [video] = await youtube.fetchVideos([videoID], process.env.YOUTUBE_API_KEY).catch(() => [])
  return durationSeconds(video?.duration)
}

async function summarizeClip (guildID, videoID, clip, { flex = false, onFirstPart = null } = {}) {
  const prompt = partPrompt(clip.start, clip.end)
  const content = await backgroundQueue.run(guildID, async () => {
    if (onFirstPart) await onFirstPart()
    return askVideo(videoID, prompt, clip, { flex, guildID })
  })
  const raw = cleanSummary(textOf(content))
  if (!raw) throw new GeminiError(`Gemini returned no summary for ${videoID} (${fmt(clip.start)}-${fmt(clip.end)})`, 'AI が動画を要約できませんでした')
  return formatPartSummary(clip.start, clip.end, raw)
}

async function mergePartSummaries (guildID, parts, { flex = false } = {}) {
  if (parts.length === 1) return parts[0].replace(/^### [^\n]+\n/, '')
  // Putting text together needs no video model: the lighter one does.
  const merged = await backgroundQueue.run(guildID, () => callGemini(lightModel(), {
    contents: [{ role: 'user', parts: [{ text: `${MERGE_PROMPT}\n\n${parts.join('\n\n')}` }] }],
    generationConfig: { temperature: 0.2 }
  }, { timeoutMs: 2 * 60 * 1000 + (flex ? FLEX_EXTRA_MS : 0), purpose: flex ? 'videoSummary-flex' : 'videoSummary', flex, defaultSafety: true }))
  return cleanSummary(textOf(merged))
}

async function summarizeParts (guildID, videoID, seconds, partSeconds, { flex = false, onFirstPart = null } = {}) {
  const parts = []
  for (const [i, clip] of partClips(seconds, partSeconds).entries()) {
    parts.push(await summarizeClip(guildID, videoID, clip, { flex, onFirstPart: i === 0 ? onFirstPart : null }))
  }
  return mergePartSummaries(guildID, parts, { flex })
}

async function summarizeInParts (guildID, videoID, { flex = false, seconds = null, maxPartSeconds = Infinity, onFirstPart = null } = {}) {
  const totalSeconds = seconds || await lengthOf(videoID)
  if (!totalSeconds) throw new GeminiError(`${videoID} is too long for one request and its length is unknown`, '動画が長すぎて一度に読めず、長さも分からないため要約できませんでした')
  const sizes = PART_SECONDS.filter(p => p < totalSeconds && p <= maxPartSeconds)
  if (sizes.length === 0) sizes.push(PART_SECONDS.at(-1))
  for (const [i, partSeconds] of sizes.entries()) {
    try {
      return await summarizeParts(guildID, videoID, totalSeconds, partSeconds, { flex, onFirstPart })
    } catch (e) {
      if (!canSplitError(e.message) || i === sizes.length - 1) throw e
    }
  }
}

async function retrySingleOrThrow (guildID, videoID, { flex = false } = {}) {
  global.logger.info(`[SUMMARY]: Retrying ${videoID} after invalid-argument error`)
  await retryTimer.sleep(CLIP_RETRY_DELAY_MS)
  try {
    const content = await backgroundQueue.run(guildID, () => askVideo(videoID, PROMPT, null, { flex, guildID }))
    return textOf(content)
  } catch (e) {
    if (INVALID_VIDEO_ARG.test(e.message)) {
      throw new GeminiError(e.message, 'AI がこの動画を読み取れませんでした（非公開・メンバー限定・アーカイブ処理中、または長さを取得できない長時間動画の可能性があります）', e.blocked, e.status)
    }
    throw e
  }
}

// onStart is called just before Gemini is asked, i.e. only when the requester will have to wait.
// force: summarize again even if a summary is stored, replacing it.
// flex: asked on Flex inference (a command's newest or short videos: summaryBatch.js, or a stream archive: liveWatcher.js).
async function summarizeVideo (guildID, url, { onStart = () => {}, force = false, flex = false, maxPartSeconds = Infinity } = {}) {
  const videoID = parseVideoId(url)
  if (!videoID) throw new Error('YouTube の動画リンクではありません')
  const cached = !force && await youtubeDB.getSummary(videoID)
  if (cached) return { videoID, summary: cleanSummary(cached) || cached, cached: true }
  const stored = durationSeconds(await youtubeDB.videoDuration(videoID).catch(() => null))
  let started = false
  const notifyStart = async () => {
    if (started) return
    started = true
    await onStart(summaryTimeoutMs())
  }
  // Waits its turn behind the owner's servers' work (backgroundQueue.js).
  let text
  if ((stored && stored > MAX_SINGLE_SECONDS) || maxPartSeconds < MAX_SINGLE_SECONDS) {
    if (stored) global.logger.info(`[SUMMARY]: ${videoID} is ${fmt(stored)} long; summarizing it in parts`)
    text = await summarizeInParts(guildID, videoID, { flex, seconds: stored, maxPartSeconds, onFirstPart: notifyStart })
  } else {
    try {
      text = textOf(await backgroundQueue.run(guildID, async () => {
        await notifyStart()
        return askVideo(videoID, PROMPT, null, { flex, guildID })
      }))
    } catch (e) {
      if (!canSplitError(e.message)) throw e
      const seconds = stored || await lengthOf(videoID)
      if (!seconds) {
        if (TOO_LONG.test(e.message)) {
          throw new GeminiError(`${videoID} is too long for one request and its length is unknown`, '動画が長すぎて一度に読めず、長さも分からないため要約できませんでした')
        }
        text = await retrySingleOrThrow(guildID, videoID, { flex })
      } else if (seconds <= PART_SECONDS.at(-1)) {
        if (!INVALID_VIDEO_ARG.test(e.message)) throw e
        text = await retrySingleOrThrow(guildID, videoID, { flex })
      } else {
        global.logger.info(`[SUMMARY]: ${videoID} is too long for one request; summarizing it in parts`)
        text = await summarizeInParts(guildID, videoID, { flex, seconds, maxPartSeconds })
      }
    }
  }
  const summary = await storeSummary(guildID, videoID, text)
  return { videoID, summary, cached: false }
}

module.exports = { summarizeVideo, summarizeClip, mergePartSummaries, lengthOf, summaryRequest, storeSummary, cleanSummary, textOf, shiftTimestamps, partClips, partPrompt, formatPartSummary, canSplitError, MAX_SUMMARY, MAX_SINGLE_SECONDS, PART_SECONDS, TOO_LONG, INVALID_VIDEO_ARG, PROMPT, MERGE_PROMPT }
