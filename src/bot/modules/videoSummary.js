// Summarizes what is said and shown in a public YouTube video, by handing its URL to Gemini, and
// keeps the summary so the same video is never summarized twice. Only run when the
// model decides it needs a video's contents (a video was linked, or a question is about what a
// video says): it is far costlier than reading titles and descriptions.
const { callGemini, DEFAULT_GEMINI_MODEL, GeminiError } = require('./eventDrafter')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const { parseVideoId } = require('../utils/youtube')
const { withoutCharCount } = require('../utils/textClean')

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
  await onStart(summaryTimeoutMs())

  const content = await callGemini(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, {
    contents: [{
      role: 'user',
      parts: [
        { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoID}` } },
        { text: PROMPT }
      ]
    }],
    // Fewer tokens per frame: the summary is about what is said and roughly shown, not fine detail.
    generationConfig: { temperature: 0.2, mediaResolution: 'MEDIA_RESOLUTION_LOW' }
  }, { timeoutMs: summaryTimeoutMs() })
  const summary = withoutCharCount(content.parts.map(p => p.text || '').join('').trim()).slice(0, MAX_SUMMARY)
  if (!summary) throw new GeminiError(`Gemini returned no summary for ${videoID}`, 'AI が動画を要約できませんでした')
  await youtubeDB.saveSummary(guildID, videoID, summary)
  return { videoID, summary, cached: false }
}

module.exports = { summarizeVideo }
