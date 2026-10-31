// A short line on what a stream will be about, for the Discord event made for it (liveWatcher.js).
// Made from what is known before it starts: its title, its description and its thumbnail. Gemini
// can't watch a stream that is still live, so the contents themselves are summarized once its
// archive is up (summarizeArchives in liveWatcher.js).
const { callGemini, DEFAULT_GEMINI_MODEL } = require('./eventDrafter')
const { isGatewayConfigured } = require('../utils/aiGateway')
const { withoutCharCount } = require('../utils/textClean')
const backgroundQueue = require('../utils/backgroundQueue')
const gameLinks = require('./gameLinks')

const MAX_BLURB = 200
const TIMEOUT_MS = 30 * 1000
const MAX_WAIT_MS = 60 * 1000

const PROMPT = [
  '次の YouTube 配信について、JSON で答えてください。',
  '- blurb: Discord のイベント説明に使う告知文。日本語2〜3文の短い文章で、何をする配信か（ゲーム名・企画・ゲストなど）が一目で分かるように。前置き・見出し・文字数は書かない。',
  '- games: 配信で遊ぶゲーム。name に正式な名前（日本語名があれば日本語名）、name_en に英語の正式名（あれば）。ゲーム配信でなければ空の配列。',
  'タイトル・概要欄・サムネイルから読み取れることだけを使い、推測で付け足さないでください。'
].join('\n')

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    blurb: { type: 'STRING' },
    games: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, name_en: { type: 'STRING' } }, required: ['name'] } }
  },
  required: ['blurb', 'games']
}

function enabled () {
  return isGatewayConfigured() && process.env.LIVE_EVENT_AI_DESCRIPTION !== 'false'
}

// { blurb, games: [{ name, url }] }: the line, and the pages of the games played (gameLinks.js), or
// null when it is turned off or Gemini fails: the event is made without them then.
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
    generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: SCHEMA }
  }, { timeoutMs: TIMEOUT_MS })
  const answer = JSON.parse(content.parts.map(p => p.text || '').join('') || '{}')
  const blurb = withoutCharCount(String(answer.blurb || '').trim()).slice(0, MAX_BLURB) || null
  const named = (Array.isArray(answer.games) ? answer.games : [])
    .filter(g => String(g?.name || '').trim())
    .map(g => ({ name: String(g.name).trim(), nameEn: String(g.name_en || '').trim() || null }))
  const games = await gameLinks.linksFor(named, { log: m => global.logger.warn(`[LIVE]: ${m}`) })
  return blurb || games.length ? { blurb, games } : null
}

module.exports = { describeStream, enabled, MAX_BLURB }
