// A short line on what a stream will be about, for the Discord event made for it (liveWatcher.js).
// Made from what is known before it starts: its title, its description and its thumbnail. Gemini
// can't watch a stream that is still live, so the contents themselves are summarized once its
// archive is up (summarizeArchives in liveWatcher.js).
const { callGemini, DEFAULT_GEMINI_MODEL } = require('./eventDrafter')
const { isGatewayConfigured } = require('../utils/aiGateway')
const { withoutCharCount } = require('../utils/textClean')
const backgroundQueue = require('../utils/backgroundQueue')

const MAX_BLURB = 200
const TIMEOUT_MS = 30 * 1000
const MAX_WAIT_MS = 60 * 1000

const PROMPT = [
  '次の YouTube 配信の告知文を、Discord のイベント説明として日本語2〜3文の短い文章で書いてください。',
  '何をする配信か（ゲーム名・企画・ゲストなど）が一目で分かるように。',
  'タイトル・概要欄・サムネイルから読み取れることだけを書き、推測で付け足さないでください。',
  '前置き・見出し・文字数は書かず、本文だけを返してください。'
].join('\n')

function enabled () {
  return isGatewayConfigured() && process.env.LIVE_EVENT_AI_DESCRIPTION !== 'false'
}

// The line, or null when it is turned off or Gemini fails: the event is made without it then.
// thumbnail: { buffer, mimeType } or null. guildID: the server the event is for; other servers than the owner's wait their turn, and get no
// line if it does not come within a minute (the event is not held up for it).
async function describeStream (video, thumbnail = null, guildID = null) {
  if (!enabled()) return null
  try {
    return await backgroundQueue.run(guildID, () => askGemini(video, thumbnail), { maxWaitMs: MAX_WAIT_MS })
  } catch (e) {
    global.logger.warn(`[LIVE]: Could not describe ${video.id}: ${e.message}`)
    return null
  }
}

async function askGemini (video, thumbnail) {
  const parts = [{ text: `${PROMPT}\n\nタイトル: ${video.title}\n概要欄:\n${(video.description || '（なし）').slice(0, 3000)}` }]
  if (thumbnail) parts.push({ inlineData: { mimeType: thumbnail.mimeType || 'image/jpeg', data: thumbnail.buffer.toString('base64') } })
  const content = await callGemini(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.3 }
  }, { timeoutMs: TIMEOUT_MS })
  const text = withoutCharCount(content.parts.map(p => p.text || '').join('').trim())
  return text ? text.slice(0, MAX_BLURB) : null
}

module.exports = { describeStream, enabled, MAX_BLURB }
