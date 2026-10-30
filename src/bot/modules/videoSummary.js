// Summarizes what is said and shown in a public YouTube video, by handing its URL to Gemini, and
// keeps the summary so the same video is never summarized twice for a server. Only run when the
// model decides it needs a video's contents (a video was linked, or a question is about what a
// video says): it is far costlier than reading titles and descriptions.
const { callGemini, GeminiError } = require('./eventDrafter')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const { parseVideoId } = require('../utils/youtube')

const MAX_SUMMARY = 3000
// A summary is about what is said, so the cheapest model and one frame every 10 seconds do: an hour
// of video is then about 140k tokens (audio 32 a second, frames 66 each), mostly audio.
const DEFAULT_SUMMARY_MODEL = 'gemini-2.5-flash-lite'
const DEFAULT_FPS = 0.1

function summaryModel () {
  return process.env.VIDEO_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL
}

function framesPerSecond () {
  const fps = Number(process.env.VIDEO_SUMMARY_FPS)
  return fps > 0 ? fps : DEFAULT_FPS
}
// Gemini watches the whole video before answering, so an hour-long stream archive can take
// several minutes. VIDEO_SUMMARY_TIMEOUT_MINUTES overrides the default.
const DEFAULT_TIMEOUT_MINUTES = 10

function summaryTimeoutMs () {
  const minutes = Number(process.env.VIDEO_SUMMARY_TIMEOUT_MINUTES)
  return (minutes > 0 ? minutes : DEFAULT_TIMEOUT_MINUTES) * 60 * 1000
}

const PROMPT = [
  'この YouTube 動画の内容を、日本語で要約してください（1500文字以内）。',
  '話している主な話題を順に箇条書きにし、告知・イベント・日時・場所・出演者・URL など、',
  'イベント登録や告知文作りに使える具体的な情報は漏らさず含めてください。',
  '分からないことは推測で書かないでください。'
].join('\n')

// onStart is called just before Gemini is asked, i.e. only when the requester will have to wait.
// force: summarize again even if a summary is stored, replacing it. byokAlias: another key stored
// in the gateway to use (the backlog's free-tier key).
async function summarizeVideo (guildID, url, { onStart = () => {}, force = false, byokAlias = null } = {}) {
  const videoID = parseVideoId(url)
  if (!videoID) throw new Error('YouTube の動画リンクではありません')
  const cached = !force && await youtubeDB.getSummary(guildID, videoID)
  if (cached) return { videoID, summary: cached, cached: true }
  await onStart(summaryTimeoutMs())

  const content = await callGemini(summaryModel(), {
    contents: [{
      role: 'user',
      parts: [
        { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoID}` }, videoMetadata: { fps: framesPerSecond() } },
        { text: PROMPT }
      ]
    }],
    // Fewer tokens per frame: the summary is about what is said and roughly shown, not fine detail.
    generationConfig: { temperature: 0.2, mediaResolution: 'MEDIA_RESOLUTION_LOW' }
  }, { timeoutMs: summaryTimeoutMs(), byokAlias })
  const summary = content.parts.map(p => p.text || '').join('').trim().slice(0, MAX_SUMMARY)
  if (!summary) throw new GeminiError(`Gemini returned no summary for ${videoID}`, 'AI が動画を要約できませんでした')
  await youtubeDB.saveSummary(guildID, videoID, summary)
  return { videoID, summary, cached: false }
}

module.exports = { summarizeVideo, summaryModel, framesPerSecond }
