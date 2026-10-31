// Summarizes what is said and shown in a public YouTube video, by handing its URL to Gemini, and
// keeps the summary so the same video is never summarized twice. Only run when the
// model decides it needs a video's contents (a video was linked, or a question is about what a
// video says): it is far costlier than reading titles and descriptions.
const { callGemini, DEFAULT_GEMINI_MODEL, GeminiError } = require('./eventDrafter')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const youtube = require('../utils/youtube')
const { parseVideoId, durationSeconds } = youtube
const { withoutCharCount } = require('../utils/textClean')
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
  'この YouTube 動画の内容を、日本語で要約してください（長くても1500文字程度まで）。要約の中に文字数は書かないでください。',
  '話している主な話題を順に箇条書きにし、各項目の先頭にその話題が始まる動画内の時間を [分:秒]（1時間以上なら [時:分:秒]）で書いてください。',
  '告知・イベント・日時・場所・出演者・URL など、',
  'イベント登録や告知文作りに使える具体的な情報は漏らさず含めてください。',
  '分からないことは推測で書かないでください。'
].join('\n')

// A video longer than Gemini can take in at once (about 3 hours at low resolution: its input is at
// most about a million tokens) is summarized two hours at a time (one hour if that is still too
// much), and the parts' summaries are then put together into one.
const PART_SECONDS = [2 * 60 * 60, 60 * 60]
const TOO_LONG = /input token count exceeds/i

const fmt = seconds => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor(seconds % 3600 / 60)
  const s = seconds % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

// [分:秒] / [時:分:秒] written from the start of a part, moved to be from the start of the video.
function shiftTimestamps (text, offset) {
  if (!offset) return text
  return text.replace(/\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/g, (whole, h, m, s) => `[${fmt(offset + Number(h || 0) * 3600 + Number(m) * 60 + Number(s))}]`)
}

const textOf = content => content.parts.map(p => p.text || '').join('').trim()

function askVideo (videoID, prompt, clip = null) {
  return callGemini(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, {
    contents: [{
      role: 'user',
      parts: [
        { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoID}` }, ...(clip ? { videoMetadata: { startOffset: `${clip.start}s`, endOffset: `${clip.end}s` } } : {}) },
        { text: prompt }
      ]
    }],
    // Fewer tokens per frame: the summary is about what is said and roughly shown, not fine detail.
    generationConfig: { temperature: 0.2, mediaResolution: 'MEDIA_RESOLUTION_LOW' }
  }, { timeoutMs: summaryTimeoutMs() })
}

// The video's length in seconds: as stored, or from the YouTube API. Null when unknown.
async function lengthOf (videoID) {
  const stored = durationSeconds(await youtubeDB.videoDuration(videoID).catch(() => null))
  if (stored) return stored
  if (!process.env.YOUTUBE_API_KEY) return null
  const [video] = await youtube.fetchVideos([videoID], process.env.YOUTUBE_API_KEY).catch(() => [])
  return durationSeconds(video?.duration)
}

async function summarizeInParts (guildID, videoID) {
  const seconds = await lengthOf(videoID)
  if (!seconds) throw new GeminiError(`${videoID} is too long for one request and its length is unknown`, '動画が長すぎて一度に読めず、長さも分からないため要約できませんでした')
  for (const [i, partSeconds] of PART_SECONDS.entries()) {
    try {
      return await summarizeParts(guildID, videoID, seconds, partSeconds)
    } catch (e) {
      if (!TOO_LONG.test(e.message) || i === PART_SECONDS.length - 1) throw e
    }
  }
}

async function summarizeParts (guildID, videoID, seconds, partSeconds) {
  const parts = []
  for (let start = 0; start < seconds; start += partSeconds) {
    const end = Math.min(seconds, start + partSeconds)
    const prompt = `${PROMPT}\n\nこれは長い動画の ${fmt(start)}〜${fmt(end)} の部分だけです。この部分だけを要約し、時間はこの部分の最初を [0:00] として書いてください。`
    const content = await backgroundQueue.run(guildID, () => askVideo(videoID, prompt, { start, end }))
    parts.push(`### ${fmt(start)}〜${fmt(end)}\n${shiftTimestamps(textOf(content), start)}`)
  }
  if (parts.length === 1) return parts[0].split('\n').slice(1).join('\n')
  const merged = await backgroundQueue.run(guildID, () => callGemini(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, {
    contents: [{ role: 'user', parts: [{ text: `次は1本の長い動画を時間で分けて要約したものです。これを1つの要約にまとめてください（長くても1500文字程度まで。文字数は書かない）。話題の順に箇条書きにし、各項目の先頭の [時間] は書き換えずにそのまま残してください。告知・日時・出演者・URL など具体的な情報は残してください。\n\n${parts.join('\n\n')}` }] }],
    generationConfig: { temperature: 0.2 }
  }, { timeoutMs: 2 * 60 * 1000 }))
  return textOf(merged)
}

// onStart is called just before Gemini is asked, i.e. only when the requester will have to wait.
// force: summarize again even if a summary is stored, replacing it.
async function summarizeVideo (guildID, url, { onStart = () => {}, force = false } = {}) {
  const videoID = parseVideoId(url)
  if (!videoID) throw new Error('YouTube の動画リンクではありません')
  const cached = !force && await youtubeDB.getSummary(videoID)
  if (cached) {
    await youtubeDB.saveSummary(guildID, videoID)
    return { videoID, summary: cached, cached: true }
  }
  // Waits its turn behind the owner's servers' work (backgroundQueue.js).
  let text
  try {
    text = textOf(await backgroundQueue.run(guildID, async () => {
      await onStart(summaryTimeoutMs())
      return askVideo(videoID, PROMPT)
    }))
  } catch (e) {
    if (!TOO_LONG.test(e.message)) throw e
    global.logger.info(`[SUMMARY]: ${videoID} is too long for one request; summarizing it in parts`)
    text = await summarizeInParts(guildID, videoID)
  }
  const summary = withoutCharCount(text).slice(0, MAX_SUMMARY)
  if (!summary) throw new GeminiError(`Gemini returned no summary for ${videoID}`, 'AI が動画を要約できませんでした')
  await youtubeDB.saveSummary(guildID, videoID, summary)
  return { videoID, summary, cached: false }
}

module.exports = { summarizeVideo, shiftTimestamps }
