const crypto = require('crypto')
const { SUBMIT_FORUM_DECLARATION, IMAGE_INSTRUCTION_PROPERTY, toForumPost, imageUrlsOf, imageInstructionOf, MAX_IMAGE_CANDIDATES } = require('./forumPost')
const { SUBMIT_CHANNEL_POST_DECLARATION, toChannelPost } = require('./channelPost')
const { withoutCharCount } = require('../utils/textClean')
const { wrap } = require('../utils/untrusted')
const { urlsIn } = require('../utils/linkSafety')
const { Agent } = require('undici')
const { gatewayURL, gatewayAuthHeaders, isGatewayConfigured, hasDefaultEndpoint, customBase } = require('../utils/aiGateway')
const { textChunks } = require('../utils/jsonItems')
const geminiLoad = require('../utils/geminiLoad')
const aiCache = require('../utils/aiCache')
const sokudan = require('../utils/sokudan')
const prompts = require('../utils/prompts')
const { mentionsMinor, isUnsafeMinorContent } = require('../utils/minorSafety')
const { currentUsage, recordTokens, addTokens, addModel, addFallback, addContext, setPrompt } = require('../utils/geminiUsage')
const aiTranscript = require('../utils/aiTranscript')

// A fixed model, not an alias such as gemini-flash-latest: an explicit cache (below) is made for one
// model, and a change of model should be a choice, not a surprise.
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'
const GEMINI_TIMEOUT_MS = 60000
// One step of a mention reply or draft, thinking at high and maybe writing a long answer, can take
// well over a minute: GEMINI_REPLY_TIMEOUT_SECONDS (default 180) gives it longer.
const DEFAULT_REPLY_TIMEOUT_SECONDS = 180
function replyTimeoutMs () {
  const n = Number(process.env.GEMINI_REPLY_TIMEOUT_SECONDS)
  return (process.env.GEMINI_REPLY_TIMEOUT_SECONDS && Number.isFinite(n) && n > 0 ? n : DEFAULT_REPLY_TIMEOUT_SECONDS) * 1000
}
// Each step is one Gemini round trip; a draft normally needs 1-3 lookups (and maybe a question)
// before submitting, a chat reply sometimes many more (wiki, X, videos, …). Lookups cost few
// tokens, so the limit is generous; GEMINI_MAX_STEPS changes it. The last step may only submit,
// with what was looked up by then.
const MAX_STEPS = 20
function maxSteps () {
  const n = Number(process.env.GEMINI_MAX_STEPS)
  return Number.isInteger(n) && n >= 1 ? n : MAX_STEPS
}
const LAST_STEP_NOTE = prompts.render('chat/last-step')
// Put in place of the tool results when they got the request refused (runAgent).
const WITHHELD_NOTE = prompts.render('chat/withheld')
// Dates in messages and event pages are written for this community's local time.
const TIMEZONE = 'Asia/Tokyo'

const ENTITY_TYPES = { stage: 1, voice: 2, external: 3 }
const DEFAULT_DURATION_MS = 60 * 60 * 1000

// The model ends every draft by calling one of these, so its answer is always structured arguments
// rather than free text that would need parsing.
// The descriptions are in prompts/tools/submit_event_draft.md.
const SUBMIT_EVENT_DECLARATION = prompts.tool('submit_event_draft', {
  view: { maxImages: MAX_IMAGE_CANDIDATES },
  parameters: {
    type: 'OBJECT',
    properties: {
      found: { type: 'BOOLEAN' },
      reason: { type: 'STRING' },
      name: { type: 'STRING' },
      description: { type: 'STRING' },
      start: { type: 'STRING' },
      end: { type: 'STRING' },
      location_type: { type: 'STRING', enum: ['external', 'voice', 'stage'] },
      location: { type: 'STRING' },
      image_urls: { type: 'ARRAY', items: { type: 'STRING' } },
      image_instruction: IMAGE_INSTRUCTION_PROPERTY,
      channel_id: { type: 'STRING' }
    },
    required: ['found']
  }
})

const MAX_CHAT_REPLY = 12000

const SUBMIT_CHAT_DECLARATION = prompts.tool('submit_chat_reply', {
  parameters: { type: 'OBJECT', properties: { text: { type: 'STRING' } }, required: ['text'] }
})

const SUBMIT_DECLARATIONS = [SUBMIT_EVENT_DECLARATION, SUBMIT_FORUM_DECLARATION, SUBMIT_CHANNEL_POST_DECLARATION, SUBMIT_CHAT_DECLARATION]

// The submit tool for each kind of thing the bot makes, which is the only one offered (with the
// chat reply) when something it made is being changed.
const SUBMIT_FOR_KIND = { event: SUBMIT_EVENT_DECLARATION, forum: SUBMIT_FORUM_DECLARATION, message: SUBMIT_CHANNEL_POST_DECLARATION }

// How varied the answers are (GEMINI_TEMPERATURE, 0-2). Chat replies want some variety; drafts
// are checked field by field (toScheduledEvent, toForumPost) whatever the model writes.
// Gemini 3 is tuned for 1.0 and may loop below it.
const DEFAULT_TEMPERATURE = 1
function temperature () {
  const t = Number(process.env.GEMINI_TEMPERATURE)
  return process.env.GEMINI_TEMPERATURE && t >= 0 && t <= 2 ? t : DEFAULT_TEMPERATURE
}

// Sent with every request, unchanged, so Gemini can reuse it from its cache: what changes per
// request (the time, the server, the request) goes in the prompt instead (buildPrompt).
// What the bot calls its model when asked (BOT_MODEL_NAME, default nobaman llm 3.9 Flash).
function modelName () {
  return String(process.env.BOT_MODEL_NAME || '').trim() || 'nobaman llm 3.9 Flash'
}

// The system instructions for chat replies and drafts (prompts/chat/system.md), with extra
// character notes from the operator (CHAT_PERSONA), e.g. a catchphrase or how to address members.
// How far dirty jokes and adult requests go is said here, by the server's safety filter (open or
// filtered), and never in the request: next to words of a request such as 児童, Google blocks the
// whole request — and when the request itself mentions minor terms (omitMature), adult policy text
// is omitted altogether so sexual terms never co-occur with minor terms in the Gemini payload.
// uncensored: for the uncensored model, whose own rules say how far adult requests go
// (prompts/chat/uncensored/rules.md) in place of this.
// settings: the server's way of speaking and reply length (serverSettings), also in these
// instructions and never in the request; '' to leave them out (a story by the uncensored model).
function systemInstruction ({ uncensored = false, safetyFilter = false, omitMature = false, settings = '', streamerPersona = true, model = null } = {}) {
  const streamerMode = streamerPersona !== false
  return prompts.render('chat/system', {
    modelName: streamerMode ? modelName() : (model || 'Gemini'),
    persona: streamerMode ? (process.env.CHAT_PERSONA || '').trim() : '',
    streamerMode,
    uncensored,
    mature: (uncensored || omitMature) ? '' : prompts.render(safetyFilter ? 'chat/mature/filtered' : 'chat/mature/open'),
    settings
  })
}

// The server's way of speaking (/persona) and reply length (/replylength), for the system
// instructions (prompts/chat/settings.md). There are a few of them, so a few caches.
function serverSettings ({ streamerPersona = true, replyLength = null } = {}) {
  return prompts.render('chat/settings', {
    speaker: streamerPersona === false ? PERSONAS.bot : PERSONAS.streamer,
    replyLength: REPLY_LENGTHS[replyLengthOf(replyLength)].join('\n')
  })
}

function isConfigured () {
  return isGatewayConfigured()
}

function formatNow (now) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: TIMEZONE, dateStyle: 'full', timeStyle: 'short'
  }).format(now)
}

const EDIT_LABELS = { event: 'イベント', forum: 'フォーラム投稿', message: 'チャンネルへの書き込み' }

// How long replies are, set per server with /replylength. long is how replies were before they were
// fitted to what was said, and the default. The rules go with each request (not the cached system
// instructions), so every server shares one cache.
const REPLY_LENGTHS = {
  long: prompts.lines('chat/reply-length/long'),
  normal: prompts.lines('chat/reply-length/normal'),
  short: prompts.lines('chat/reply-length/short')
}
const DEFAULT_REPLY_LENGTH = 'long'

// Who the replies speak as, set per server with /persona: the streamer (the default) or the bot.
// Both ways are described in the system instructions, and so is which (serverSettings).
const PERSONAS = {
  streamer: prompts.render('chat/persona/streamer'),
  bot: prompts.render('chat/persona/bot')
}
const replyLengthOf = length => REPLY_LENGTHS[length] ? length : DEFAULT_REPLY_LENGTH

// The request as the model gets it, the parts that change least first and the request itself last:
// what stays the same from one request to the next (the server's setting and information) leads,
// so a prompt cache can cover as much as possible, and what is new each time (the time, the
// conversation, the request) follows.
function buildPrompt ({ request, referenced, recent = [], channelName, channelID, channelInfo = null, server, forum, images, edit, channels = [], people = [], now }) {
  const lines = []
  if (server) lines.push('## このサーバーの情報（最新）', wrap('server', server))
  if (channels.length) lines.push(...(lines.length ? [''] : []), '## 依頼や会話に出てくるチャンネル', wrap('channels', channels.join('\n')))
  lines.push(...(lines.length ? [''] : []), `依頼されたチャンネル: ${channelInfo || `#${channelName}${channelID ? `（ID: ${channelID}）` : ''}`}`)
  // Who asked and who the request names, so the reply knows who is who (names are the members' own).
  if (people.length) lines.push('', '## 依頼した人と、依頼や会話に出てくるメンバー（<@ID> は Discord のメンション）', wrap('members', people.join('\n')))
  // What was just being talked about in the channel, as far as it bears on the request (recentTopics.js).
  if (recent.length) lines.push('', '## 依頼されたチャンネルの最近の会話（依頼に関係しそうなものだけ。古い順）', wrap('recent', recent.join('\n')))
  if (forum) lines.push('', `## 投稿先に指定されたフォーラム\n${forum.id}: ${forum.name}（フォーラムに投稿する場合はここに投稿する）`)
  if (edit) {
    const submit = SUBMIT_FOR_KIND[edit.kind].name
    lines.push('', `## 修正する${EDIT_LABELS[edit.kind]}（BOT が作成済み）`,
      `依頼は、すでに作成したこの${EDIT_LABELS[edit.kind]}の修正です。依頼された点だけを変え、それ以外の項目は下の現在の値のまま ${submit} で提出してください。`,
      '画像は依頼者がボタンで選ぶので、image_urls は依頼メッセージで新しい画像を指定されたときだけ入れてください。画像の変更や差し替えを指示されたときは image_instruction に入れてください。',
      wrap('current', ['```json', JSON.stringify(edit.current, null, 2), '```'].join('\n')))
  } else if (referenced?.count > 1) {
    lines.push('', '## 依頼メッセージの返信先（返信をたどった会話。古い順で、最後が直接の返信先。依頼メッセージはこの続き）', wrap('conversation', referenced.text))
  } else if (referenced) {
    lines.push('', '## 依頼メッセージの返信先', wrap('conversation', referenced.text))
  }
  lines.push('', `現在日時: ${formatNow(now)}（${TIMEZONE}）`,
    '', `## 依頼メッセージ（${[...String(request || '')].length}文字）`,
    request ? wrap('request', request) : (!referenced && images.length ? '（本文なし。添付された画像を見て返事や作成をしてください）' : '（本文なし。返信先のメッセージから作成）'))
  if (images.length !== 0) lines.push('', '## 依頼メッセージの添付画像', ...images.map(url => `- ${url}`))
  return lines.join('\n')
}

// A failed Gemini call. `hint` is safe to show the requester (who is server staff); `message` has
// the response body for the logs.
// `blocked`: why Google refused to answer (a promptFeedback.blockReason such as PROHIBITED_CONTENT,
// or a safety finishReason), null for any other failure. Asking again with the same input is
// refused again.
class GeminiError extends Error {
  constructor (message, hint, blocked = null, status = null) {
    super(message)
    this.hint = hint
    this.blocked = blocked
    this.status = status // the HTTP status of a failed request
  }
}

// The blocks that may be about adult content, which the uncensored model can answer instead.
const R18_BLOCKS = ['SAFETY', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT']
const BLOCKING_FINISH_REASONS = ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'RECITATION']

// fetch gives up on a response that has not started after 5 minutes (undici's headersTimeout and
// bodyTimeout), whatever the AbortSignal says. Gemini answers only once it is done, so a call
// allowed longer than that needs its own dispatcher with matching limits.
const FETCH_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const longCallAgents = new Map()
function dispatcherFor (timeoutMs) {
  if (timeoutMs <= FETCH_DEFAULT_TIMEOUT_MS) return undefined
  if (!longCallAgents.has(timeoutMs)) {
    longCallAgents.set(timeoutMs, new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }))
  }
  return longCallAgents.get(timeoutMs)
}

// HTTP 429 is retried: from AI Gateway's own rate limit (requests per interval, set on the gateway)
// or from Gemini's quota. Waits Retry-After when given, else 2s, 4s, 8s; never longer than 30s.
const MAX_RETRIES = 3
const MAX_RETRY_WAIT_MS = 30 * 1000
const retryTimer = { sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) }

function retryDelayMs (retryAfter, attempt) {
  const seconds = Number(retryAfter)
  const ms = seconds > 0 ? seconds * 1000 : 2000 * 2 ** attempt
  return Math.min(ms, MAX_RETRY_WAIT_MS)
}

// Which limit a 429 hit, for the requester: the gateway's (fixable in the Cloudflare dashboard)
// or Gemini's.
function rateLimitHint (body) {
  return /AiGatewayError|"internalCode":2003/.test(body)
    ? 'AI Gateway のリクエスト数の上限に達しました。Cloudflare の AI Gateway の Rate-limiting 設定を確認してください'
    : 'Gemini の利用上限に達しました（HTTP 429）'
}

// One Gemini API call through the gateway (`method` such as "generateContent"), retrying HTTP 429.
// Returns the response body. purpose: what it is for, to count its tokens by (geminiUsage.js).
// options.stream: a generateContent call is made as streamGenerateContent (server-sent events) and
// put back together as one response (streamed). Cloudflare gives up on a response that has not
// started within 100 seconds (HTTP 524 through the gateway's custom domain), and a call that
// thinks at high, or waits for Flex, can take longer: streamed, with the model's thought summaries
// on (includeThoughts), bytes keep coming while it thinks. GEMINI_STREAM=false turns it off.
async function geminiRequest (model, method, body, options = {}) {
  const stream = !!options.stream && method === 'generateContent' && process.env.GEMINI_STREAM !== 'false'
  if (stream && body.generationConfig?.thinkingConfig) {
    body = { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { ...body.generationConfig.thinkingConfig, includeThoughts: true } } }
  }
  const path = stream ? `models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse` : `models/${encodeURIComponent(model)}:${method}`
  return geminiPost(path, body, { ...options, model, stream })
}

// A streamed response (server-sent events, one GenerateContentResponse per `data:` line) as one
// response: the parts of every chunk in order, with the last finish reason, usage and feedback.
// Thought summaries are only there to keep the stream going and are left out, but for a part that
// carries a thought signature (which must go back to the model as it came); runs of plain text are
// joined. A response that is not a stream (no body to read) is read as it is.
async function streamed (res) {
  if (!res.body) return res.json()
  const parts = []
  let sawData = false
  let sawCandidate = false
  let rawAll = ''
  const merged = { candidates: [{ content: { role: 'model', parts } }] }
  const take = line => {
    const m = line.match(/^data:\s*(.*)$/)
    if (!m) return
    sawData = true
    if (!m[1].trim() || m[1].trim() === '[DONE]') return
    let chunk
    try { chunk = JSON.parse(m[1]) } catch (_) { return }
    if (chunk?.error) {
      const code = Number(chunk.error.code) || null
      const msg = chunk.error.message || JSON.stringify(chunk.error)
      const hint = code ? `AI の呼び出しに失敗しました（HTTP ${code}）` : 'AI の呼び出しに失敗しました'
      throw new GeminiError(msg, hint, null, code)
    }
    const candidate = chunk.candidates?.[0]
    if (candidate) sawCandidate = true
    for (const part of candidate?.content?.parts || []) {
      if (part.thought && !part.thoughtSignature) continue
      const last = parts[parts.length - 1]
      const plain = p => typeof p.text === 'string' && !p.thought && !p.thoughtSignature && Object.keys(p).length === 1
      if (last && plain(last) && plain(part)) last.text += part.text
      else parts.push({ ...part })
    }
    if (candidate?.finishReason) merged.candidates[0].finishReason = candidate.finishReason
    // Why a candidate was blocked comes with its last chunk, and is what the mention log shows.
    if (candidate?.safetyRatings?.length) merged.candidates[0].safetyRatings = candidate.safetyRatings
    if (chunk.usageMetadata) merged.usageMetadata = chunk.usageMetadata
    if (chunk.promptFeedback) merged.promptFeedback = chunk.promptFeedback
  }
  let buffer = ''
  for await (const text of textChunks(res)) {
    rawAll += text
    buffer += text
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop()
    lines.forEach(take)
  }
  take(buffer)
  if (!sawData && rawAll.trim()) {
    let parsed = null
    try { parsed = JSON.parse(rawAll) } catch (_) {}
    if (parsed?.error) {
      const code = Number(parsed.error.code) || null
      const msg = parsed.error.message || JSON.stringify(parsed.error)
      const hint = code ? `AI の呼び出しに失敗しました（HTTP ${code}）` : 'AI の呼び出しに失敗しました'
      throw new GeminiError(msg, hint, null, code)
    }
    if (parsed) return parsed
  }
  if (!sawCandidate) merged.candidates = []
  return merged
}

// The headers of every Gemini call through the gateway.
function geminiHeaders () {
  const headers = { 'Content-Type': 'application/json', ...gatewayAuthHeaders() }
  // Optional: the Gemini key can be stored in the gateway (BYOK) instead.
  if (process.env.GEMINI_API_KEY) headers['x-goog-api-key'] = process.env.GEMINI_API_KEY
  // Which stored (BYOK) key to use. Without it the gateway looks for one named "default".
  if (process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS) headers['cf-aig-byok-alias'] = process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS
  return headers
}

// A GET or DELETE to the Gemini API (`path` under v1beta) through the gateway, without retries.
// Returns the response body (empty for DELETE).
async function geminiSend (method, path, { timeoutMs = 30 * 1000 } = {}) {
  const res = await fetch(gatewayURL(`google-ai-studio/v1beta/${path}`), {
    method,
    headers: geminiHeaders(),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300)
    throw new GeminiError(`Gemini ${method} ${path} failed: HTTP ${res.status} ${text}`, `AI の呼び出しに失敗しました（HTTP ${res.status}）`, null, res.status)
  }
  return method === 'DELETE' ? {} : res.json()
}

// A GET to the Gemini API (`path` under v1beta) whose response is read as it streams in (a batch's
// results): resolves to the fetch Response, its body not yet read.
async function geminiStream (path, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const res = await fetch(gatewayURL(`google-ai-studio/v1beta/${path}`), {
    method: 'GET',
    headers: geminiHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: dispatcherFor(timeoutMs)
  })
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300)
    throw new GeminiError(`Gemini GET ${path} failed: HTTP ${res.status} ${text}`, `AI の呼び出しに失敗しました（HTTP ${res.status}）`, null, res.status)
  }
  return res
}

// Flex inference is asked for unless GEMINI_FLEX=false. A Flex request says nothing while it is
// queued (minutes), and through the gateway's custom domain Cloudflare gives up after 100 seconds
// (HTTP 524), so it goes to the gateway's default endpoint instead (gatewayURL's direct), which
// needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_GATEWAY_ID.
function flexUsable () {
  return process.env.GEMINI_FLEX !== 'false'
}
let warnedFlexDomain = false

// One POST to the Gemini API (`path` under v1beta) through the gateway, retrying HTTP 429.
// flex: Flex inference (serviceTier flex, half the price, queued for minutes at most), sent to the
// default endpoint (flexUsable) and also retried on HTTP 503 (no Flex capacity). It is not sent at
// the standard tier when Flex fails, unless GEMINI_DEEP_FLEX_FALLBACK=true: the caller deals with
// the failure (the stronger model's turn is answered by the usual model, runAgent).
// Every call is recorded for the mention being handled (aiTranscript.js), as sent, with how many
// times it was sent: options.transcript names the system instructions and tools when they are in a
// cache rather than the body. A Flex call asked again at the standard tier is recorded as it ended,
// and the standard one on its own.
async function geminiPost (path, body, options = {}) {
  const sent = { body, attempts: 0 }
  const record = result => aiTranscript.recordGemini({ model: options.model || '', purpose: options.purpose || 'other', body: sent.body, ...options.transcript, attempts: sent.attempts, ...result })
  let data
  try {
    data = await geminiAttempts(path, body, options, sent)
  } catch (e) {
    record({ error: e })
    throw e
  }
  if (data instanceof StandardTier) {
    record({ error: data.why })
    const purpose = String(options.purpose || 'other').replace(/-flex$/, '')
    return geminiPost(path, data.body, { ...options, purpose, flex: false, standard: true })
  }
  record({ response: data })
  return data
}

// A Flex call that is to be asked again at the standard tier (GEMINI_DEEP_FLEX_FALLBACK or flexFallback).
class StandardTier {
  constructor (body, why) {
    this.body = body
    this.why = why
  }
}

async function geminiAttempts (path, body, { timeoutMs = GEMINI_TIMEOUT_MS, purpose = 'other', model = '', flex = false, stream = false, standard = false, flexFallback = null, flexMaxRetries = null, standardMaxRetries = null, maxRetries = null } = {}, sent = {}) {
  const usage = currentUsage()
  // A user near their limits has every generation of their mention on Flex (mentionQuota.js), and
  // when the bot as a whole is busy every generation is, in the background too (geminiLoad.js);
  // but for image models.
  const isGenerate = /:(stream)?[gG]enerateContent/.test(path) && !/(?:image|nano-banana)/i.test(model)
  const loadFlex = !flex && !standard && !usage?.flex && isGenerate && geminiLoad.flexForAll()
  if ((usage?.flex || loadFlex) && isGenerate) flex = true
  flex = flex && !standard && flexUsable()
  if (flex && loadFlex && purpose.startsWith('mention') && usage?.onFlex) {
    await Promise.resolve(usage.onFlex()).catch(() => {})
  }
  const url = gatewayURL(`google-ai-studio/v1beta/${path}`, { direct: flex })
  if (flex && customBase() && !hasDefaultEndpoint() && !warnedFlexDomain) {
    warnedFlexDomain = true
    global.logger?.warn('[GEMINI]: Flex requests go through CLOUDFLARE_AI_GATEWAY_URL, where Cloudflare gives up after 100 seconds (HTTP 524); set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_GATEWAY_ID so they go to the default endpoint')
  }
  const headers = geminiHeaders()
  if (flex) body = { ...body, serviceTier: 'flex' }
  sent.body = body

  const tierRetries = flex ? flexMaxRetries : standardMaxRetries
  const retries = Number.isInteger(tierRetries) && tierRetries >= 0
    ? tierRetries
    : (Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : MAX_RETRIES)

  let res
  for (let attempt = 0; ; attempt++) {
    if (usage) usage.requests++
    sent.attempts = attempt + 1
    res = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: dispatcherFor(timeoutMs),
      body: JSON.stringify(body)
    })
    if ((res.status !== 429 && !(flex && res.status === 503)) || attempt === retries) break
    const wait = retryDelayMs(res.headers?.get?.('retry-after'), attempt)
    await res.text().catch(() => {}) // let the connection be reused
    if (usage) {
      usage.retries++
      await usage.onWait(wait)
    }
    await retryTimer.sleep(wait)
  }
  const allowStandardFallback = flexFallback !== null ? Boolean(flexFallback) : process.env.GEMINI_DEEP_FLEX_FALLBACK === 'true'
  if (!res.ok && flex && [429, 503, 524].includes(res.status) && allowStandardFallback) {
    await res.text().catch(() => {})
    const why = res.status === 524 ? 'timed out' : 'full'
    global.logger?.info(`[GEMINI]: Flex ${why} for ${model} (HTTP ${res.status}); asking at the standard tier`)
    if (purpose.startsWith('mention')) addFallback(`${model}: Flex ${why} → standard tier`)
    const { serviceTier, ...standardBody } = body
    return new StandardTier(standardBody, `Flex ${why} (HTTP ${res.status}); asked again at the standard tier`)
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 1000)
    const hint = flex && [429, 503, 524].includes(res.status)
      ? 'AI（Flex）が混み合っていて答えられませんでした。少し時間をおいてお試しください'
      : res.status === 429 ? rateLimitHint(text) : `AI の呼び出しに失敗しました（HTTP ${res.status}）`
    throw new GeminiError(`Gemini request failed: HTTP ${res.status} ${text}`, hint, null, res.status)
  }
  const data = stream ? await streamed(res) : await res.json()
  recordTokens(purpose, model, data?.usageMetadata)
  addTokens(data?.usageMetadata, { model, flex })
  geminiLoad.record(require('../utils/mentionQuota').costOf(data?.usageMetadata, model, { flex }))
  // The model that answered the reply itself, for the line under it.
  if (purpose.startsWith('mention')) addModel(model, { flex })
  return data
}

// The lighter, cheaper model for work in the background (describing emojis, web search, game links):
// GEMINI_LIGHT_MODEL, by default gemini-3.5-flash-lite; empty to use GEMINI_MODEL for everything.
const DEFAULT_LIGHT_MODEL = 'gemini-3.5-flash-lite'
function lightModel () {
  const light = process.env.GEMINI_LIGHT_MODEL ?? DEFAULT_LIGHT_MODEL
  return light || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
}

// The ultra-light model for structured extraction (taking knowledge out of pages and server
// history): GEMINI_EXTRACT_MODEL, by default gemini-3.1-flash-lite; empty to use lightModel().
const DEFAULT_EXTRACT_MODEL = 'gemini-3.1-flash-lite'
function extractModel () {
  const extract = (process.env.GEMINI_EXTRACT_MODEL ?? DEFAULT_EXTRACT_MODEL).trim()
  return extract || lightModel()
}

// One generateContent call through the gateway. Returns the first candidate's content. A call that
// says nothing of thinking (background work: knowledge, emojis, …) thinks at low
// (GEMINI_LIGHT_THINKING_LEVEL); image models are left as they are.
// The safety filters of every request: off but for civic integrity (election misinformation and
// the like), which blocks from a medium probability. What Google never allows (such as anything
// sexual about minors) is blocked whatever these say, and they change nothing of the usage policy.
// Image models are left with their own, and so are video summaries (options.defaultSafety).
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
]
// A server with the safety filter on (/safetyfilter): every category blocks from a medium
// probability. Not from a low one: at low, a single harmless word such as 「児童」 is blocked.
// How far adult requests go there is said in the system instructions (chat/mature/filtered.md).
const STRICT_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
]
const isImageModel = model => /(?:image|nano-banana)/i.test(String(model || ''))
const isGemini4 = model => /^gemini-4(?:-|$)/i.test(String(model || ''))
const normalizeThinkingLevel = (model, level) => (level === 'minimal' && isGemini4(model) ? 'low' : level)

function withSafetySettings (model, body, { strict = false } = {}) {
  if (body.safetySettings || isImageModel(model)) return body
  return { ...body, safetySettings: strict ? STRICT_SAFETY_SETTINGS : SAFETY_SETTINGS }
}

async function callGemini (model, body, options) {
  if (!options?.defaultSafety) body = withSafetySettings(model, body, { strict: !!options?.strictSafety })
  if (!body.generationConfig?.thinkingConfig && !isImageModel(model)) {
    const thinking = thinkingConfig(model, { setting: 'GEMINI_LIGHT_THINKING_LEVEL', fallback: 'low' })
    if (thinking.thinkingConfig) body = { ...body, generationConfig: { ...body.generationConfig, ...thinking } }
  }
  // Gemini 4 migration docs specify omitting temperature/topP/topK sampling parameters.
  if (isGemini4(model) && body.generationConfig) {
    const gc = { ...body.generationConfig }
    delete gc.temperature
    delete gc.topP
    delete gc.topK
    if (Object.keys(gc).length) body = { ...body, generationConfig: gc }
    else {
      const copy = { ...body }
      delete copy.generationConfig
      body = copy
    }
  }
  const data = await geminiRequest(model, 'generateContent', body, options)
  const candidate = data.candidates?.[0]
  const content = candidate?.content
  const finish = candidate?.finishReason
  const blocked = data.promptFeedback?.blockReason || (BLOCKING_FINISH_REASONS.includes(finish) ? finish : null)
  const hasAnswer = content?.parts?.some(p => !p.thought)
  if (!hasAnswer) {
    throw new GeminiError(`Gemini returned no content: ${JSON.stringify(data).slice(0, 1000)}`, 'AI から応答がありませんでした', blocked)
  }
  return content
}

// How much Gemini 3/4 thinks before answering (minimal, low, medium or high), billed as answer
// tokens: `setting` names the environment variable, `fallback` the level without it. Mention
// replies and drafts think at high (GEMINI_THINKING_LEVEL), video summaries at low
// (VIDEO_SUMMARY_THINKING_LEVEL), and everything else at low (GEMINI_LIGHT_THINKING_LEVEL).
// Only sent to Gemini 3+ models (older ones refuse the setting). Gemini 4 rejects `minimal`,
// so it is clamped to `low` for Gemini 4 models.
const { REPLY_MODELS, THINKING_LEVELS, SERVICE_TIERS } = require('../utils/replyOptions')
const replySettings = () => require('../../db/interfaces/postgres/replySettings')

function thinkingConfig (model, { setting = 'GEMINI_THINKING_LEVEL', fallback = 'high' } = {}) {
  if (!/gemini-[3-9]/.test(model)) return {}
  const level = String(process.env[setting] || fallback).toLowerCase()
  return THINKING_LEVELS.includes(level) ? { thinkingConfig: { thinkingLevel: normalizeThinkingLevel(model, level) } } : {}
}

function defaultTaskConfig (task) {
  const entry = (model, thinkingSetting, thinkingFallback, tier) => ({
    model,
    thinkingSetting,
    thinkingFallback,
    thinking: String(process.env[thinkingSetting] || thinkingFallback).toLowerCase(),
    tier
  })
  switch (task) {
    case 'light':
      return entry(lightModel(), 'GEMINI_LIGHT_THINKING_LEVEL', 'low', 'flex')
    case 'extract':
      return entry(extractModel(), 'GEMINI_EXTRACT_THINKING_LEVEL', 'minimal', 'flex')
    case 'summary':
      return entry(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, 'VIDEO_SUMMARY_THINKING_LEVEL', 'low', 'flex')
    case 'reply':
    default:
      return entry(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, 'GEMINI_THINKING_LEVEL', 'high', 'standard')
  }
}

async function resolveTaskConfig (task, guildID = null) {
  const def = defaultTaskConfig(task)
  const custom = await replySettings().getTaskModel?.(guildID, task)?.catch?.(() => null)
  const model = custom?.model || def.model
  const thinking = custom?.thinking && THINKING_LEVELS.includes(custom.thinking)
    ? (/gemini-[3-9]/.test(model) ? { thinkingConfig: { thinkingLevel: normalizeThinkingLevel(model, custom.thinking) } } : {})
    : thinkingConfig(model, { setting: def.thinkingSetting, fallback: def.thinkingFallback })
  const tier = custom?.tier && SERVICE_TIERS.includes(custom.tier) ? custom.tier : def.tier
  return { model, thinking, tier, flex: tier === 'flex' }
}

// allowed: the only functions the model may call this turn (all of them when omitted).

// The system instructions and the tools, the same for every request of a kind, are kept in an
// explicit cache (cachedContents) for an hour at a time and referred to by name, so they are billed
// at the cached rate instead of in full every round trip; Gemini's own (implicit) cache only takes
// prompts that start with at least 4,096 identical tokens, which these are about. A cache that
// cannot be made (too small for the model, or GEMINI_EXPLICIT_CACHE=false) leaves requests as they
// were. Per worker, one cache per model and set of tools.
//
// Each cache is labelled (displayName) with the version of the system instructions it holds. The
// first cache a worker makes for a version deletes the caches of every other version on Gemini's
// side, so a changed prompt leaves nothing of the old one behind (they would otherwise stay until
// they expire). Caches of the same instructions with another set of tools are kept: workers may
// offer different tools at the same time. Only caches with this label are touched.
const CACHE_TTL_SECONDS = 3600
const CACHE_RENEW_BEFORE_MS = 5 * 60 * 1000
// After a cache Gemini would not make (HTTP 400: too small for the model, say) it is tried again an
// hour later; after any other failure (the gateway or Access refusing, a network error, an outage)
// in a few minutes, so caching comes back soon after that is fixed.
const CACHE_RETRY_AFTER_MS = 60 * 60 * 1000
const CACHE_RETRY_AFTER_ERROR_MS = 5 * 60 * 1000
const CACHE_LABEL = 'robopolice-mention'
const MAX_CACHE_LIST_PAGES = 10
const MAX_MEMORY_CACHES = 16
const MAX_MEMORY_PURGED = 16
const MAX_UNCENSORED_CACHE_KEYS = 256
const UNCENSORED_REPLY_CACHE_TTL_SECONDS = 10 * 60
const caches = new Map()
const uncensoredCacheKeys = new Set()
const rawUncensoredKeysAdd = uncensoredCacheKeys.add.bind(uncensoredCacheKeys)
uncensoredCacheKeys.add = key => {
  if (uncensoredCacheKeys.has(key)) uncensoredCacheKeys.delete(key)
  else if (uncensoredCacheKeys.size >= MAX_UNCENSORED_CACHE_KEYS) {
    uncensoredCacheKeys.delete(uncensoredCacheKeys.keys().next().value)
  }
  return rawUncensoredKeysAdd(key)
}
const rawCachesSet = caches.set.bind(caches)
caches.set = (key, value) => {
  if (caches.has(key)) caches.delete(key)
  else if (caches.size >= MAX_MEMORY_CACHES) caches.delete(caches.keys().next().value)
  return rawCachesSet(key, value)
}
const rawCachesClear = caches.clear.bind(caches)
caches.clear = ({ memoryOnly = false } = {}) => {
  if (!memoryOnly) {
    for (const key of caches.keys()) aiCache.del(`gemini-cache:${key}`)
    for (const key of uncensoredCacheKeys) aiCache.del(key)
    uncensoredCacheKeys.clear()
  }
  rawCachesClear()
}
// Versions whose older caches this worker has already deleted.
const purgedFor = new Set()
const rawPurgedAdd = purgedFor.add.bind(purgedFor)
purgedFor.add = version => {
  if (!purgedFor.has(version) && purgedFor.size >= MAX_MEMORY_PURGED) {
    purgedFor.delete(purgedFor.values().next().value)
  }
  return rawPurgedAdd(version)
}
const rawPurgedClear = purgedFor.clear.bind(purgedFor)
purgedFor.clear = ({ memoryOnly = false } = {}) => {
  if (!memoryOnly) {
    for (const version of purgedFor) aiCache.del(`gemini-cache-purged:${version}`)
  }
  rawPurgedClear()
}

function explicitCacheEnabled () {
  return process.env.GEMINI_EXPLICIT_CACHE !== 'false'
}

const hashOf = text => crypto.createHash('sha256').update(text).digest('hex')

// The version of the system instructions in `prefix`: changes whenever the prompt does.
function promptVersion (prefix) {
  return hashOf(JSON.stringify(prefix.systemInstruction || null)).slice(0, 16)
}

function deleteCache (name) {
  return geminiSend('DELETE', name).catch(e => {
    // Already gone (expired, or deleted by another worker) is what was wanted.
    if (e.status !== 404) throw e
  })
}

// Deletes this bot's caches made for other versions of the instructions. Resolves to how many.
async function purgeStaleCaches (version) {
  const stale = []
  let pageToken = ''
  for (let page = 0; page < MAX_CACHE_LIST_PAGES; page++) {
    const list = await geminiSend('GET', `cachedContents?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`)
    for (const c of list.cachedContents || []) {
      const label = String(c.displayName || '')
      if (label.startsWith(`${CACHE_LABEL}:`) && label !== `${CACHE_LABEL}:${version}`) stale.push(c.name)
    }
    pageToken = list.nextPageToken
    if (!pageToken) break
  }
  for (const name of stale) await deleteCache(name)
  return stale.length
}

let pendingPurge = Promise.resolve()

function flushCachePurge () {
  return pendingPurge
}

// The name of a cache holding `prefix` (systemInstruction, tools, toolConfig) for `model`, made if
// needed and shared across workers in Redis; null when there is none to use.
async function cachedPrefix (model, prefix, now = Date.now()) {
  if (!explicitCacheEnabled() || isGemini4(model)) return null
  const key = hashOf(`${model}\n${JSON.stringify(prefix)}`)
  const redisKey = `gemini-cache:${key}`
  const version = promptVersion(prefix)
  const known = caches.get(key)
  if (known?.failedAt && now - known.failedAt < known.retryAfter) return null
  if (known?.name && known.expiresAt - now > CACHE_RENEW_BEFORE_MS) return known.name
  const shared = await aiCache.getJson(redisKey)
  if (shared?.name && shared.expiresAt - now > CACHE_RENEW_BEFORE_MS) {
    caches.set(key, shared)
    return shared.name
  }
  try {
    const made = await geminiPost('cachedContents', { model: `models/${model}`, displayName: `${CACHE_LABEL}:${version}`, ...prefix, ttl: `${CACHE_TTL_SECONDS}s` }, { purpose: 'cache', model, timeoutMs: 30 * 1000 })
    const entry = { name: made.name, expiresAt: made.expireTime ? Date.parse(made.expireTime) : now + CACHE_TTL_SECONDS * 1000 }
    caches.set(key, entry)
    await aiCache.setJson(redisKey, entry, Math.max(60, Math.floor((entry.expiresAt - now) / 1000)))
    if (!purgedFor.has(version)) {
      purgedFor.add(version)
      // Clean up old prompt caches in the background so a deploy never stalls the first mention reply.
      const prev = pendingPurge
      const job = (async () => {
        if (await aiCache.setnx(`gemini-cache-purged:${version}`, '1', 24 * 60 * 60)) {
          const purged = await purgeStaleCaches(version).catch(e => {
            global.logger?.warn(`[GEMINI]: Could not delete the caches of earlier instructions: ${e.message.slice(0, 200)}`)
            return 0
          })
          if (purged) global.logger?.info(`[GEMINI]: Deleted ${purged} cache(s) of earlier instructions`)
        }
      })().catch(() => {})
      pendingPurge = Promise.all([prev, job]).then(() => {})
    }
    return made.name
  } catch (e) {
    const retryAfter = e.status === 400 ? CACHE_RETRY_AFTER_MS : CACHE_RETRY_AFTER_ERROR_MS
    caches.set(key, { failedAt: now, retryAfter })
    global.logger?.info(`[GEMINI]: Not caching the instructions for ${model} for ${retryAfter / 60000} minutes, sending them in full: ${e.message.slice(0, 200)}`)
    return null
  }
}

// Forgets a cache Gemini no longer has (expired early, or deleted).
function forgetCache (name) {
  for (const [key, c] of caches) {
    if (c.name === name) {
      caches.delete(key)
      aiCache.del(`gemini-cache:${key}`)
    }
  }
}

// Requests that need much reasoning or a long text are answered by a stronger model
// (GEMINI_DEEP_MODEL, by default gemini-4-hydrogen at $1.50/$7.50 per 1M; empty to turn this off),
// which the model hands over to by calling think_deeper first. If it refuses (its safety filters
// or policy), the usual model answers instead, from the request again. It runs on Flex inference
// (half the price, but queued for up to about 15 minutes; GEMINI_DEEP_FLEX=false for the standard
// tier) and thinks at GEMINI_DEEP_THINKING_LEVEL (default high), relying on Gemini 4 implicit
// caching (95% discount from 4,096 tokens) rather than explicit cachedContents.
const DEFAULT_DEEP_MODEL = 'gemini-4-hydrogen'
const DEEP_TIMEOUT_MS = 20 * 60 * 1000
const DEEP_PROGRESS = 'じっくり考えています…（強いモデルで考えるため、数分かかることがあります）'
function deepModel () {
  return (process.env.GEMINI_DEEP_MODEL ?? DEFAULT_DEEP_MODEL).trim() || null
}
const THINK_DEEPER_DECLARATION = prompts.tool('think_deeper', {
  parameters: { type: 'OBJECT', properties: { reason: { type: 'STRING' } }, required: ['reason'] }
})

// The model mention replies use: the server's own (contents.model, %replymodel), else GEMINI_MODEL.
const replyModel = contents => contents?.model || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL

// When R18 / adult content is detected or Google refuses to answer a mention (PROHIBITED_CONTENT,
// SAFETY, …) and an OpenAI-compatible uncensored endpoint is configured (UNCENSORED_API_URL or
// UNCENSORED_GATEWAY_PROVIDER), the conversation is handed over to:
// - UNCENSORED_MODEL for general Gemini block fallback (Model 1)
// - UNCENSORED_R18_MODEL for R18 / adult content requests and handovers (Model 2; falls back to UNCENSORED_MODEL)
const DEFAULT_UNCENSORED_MODEL = 'xtools-at/DeepSeek-V4-Pro-Qwen3.5-9B-UNCENSORED-heretic'

function normalizeLocalModelId (model) {
  const s = String(model || '').trim()
  if (!s) return s
  const endpoint = uncensoredEndpoint()
  if (endpoint && !endpoint.gateway && isLocalUncensoredUrl(endpoint.url)) {
    return s.replace(/\.gguf$/i, '')
  }
  return s
}

function uncensoredBaseModel () {
  const configured = String(process.env.UNCENSORED_MODEL || '').trim()
  if (configured && configured.toLowerCase() !== 'auto') return normalizeLocalModelId(configured)
  if (uncensoredState.detectedModel) return normalizeLocalModelId(uncensoredState.detectedModel)
  return DEFAULT_UNCENSORED_MODEL
}

function uncensoredR18Model () {
  const configured = String(process.env.UNCENSORED_R18_MODEL || '').trim()
  if (configured && configured.toLowerCase() !== 'auto') return normalizeLocalModelId(configured)
  if (uncensoredState.detectedR18Model) return normalizeLocalModelId(uncensoredState.detectedR18Model)
  return uncensoredBaseModel()
}

function uncensoredModel (contents = null) {
  if (contents?.explicitUncensoredModel) return normalizeLocalModelId(contents.explicitUncensoredModel)
  if (contents?.uncensoredR18Mode) return uncensoredR18Model()
  return uncensoredBaseModel()
}

// Explicit model directive at the start or end of a mention request (or in a replied-to message):
//   --model <1|2|uncensored|r18|deep|hydrogen|argon|neon|carbon|flash|lite|model-name>
//   -m <...> / model:<...> / [model:<...>] / [r18] / 【R18】
//   --1 / --2 / --uncensored / --r18 / --deep / --hydrogen / --argon / --neon / --carbon / --flash / --lite
const DIRECTIVE_ALIASES = '1|2|uncensored|fallback|heretic|r-?18|deckard|deep|argon|hydrogen|neon|carbon|flash|lite'
const BRACKET_DIRECTIVE_ALIASES = 'uncensored|fallback|heretic|r-?18|deckard|deep|argon|hydrogen|neon|carbon|flash|lite'
const LEADING_DIRECTIVE_PATTERN = new RegExp(
  `^((?:<@!?[\\w-]+>|<@&[\\w-]+>\\s*)*)\\s*(?:(?:(?:--|[—–―]{1,2}|[ー－]{2})model(?:=|:|\\s+)|-m(?:=|:|\\s+)|model\\s*[:=]\\s*)(\\S+)|\\[model\\s*[:=]\\s*([^\\]]+)\\]|(?:\\[(${BRACKET_DIRECTIVE_ALIASES})\\]|【(?:model\\s*[:=]\\s*)?(${BRACKET_DIRECTIVE_ALIASES})】)(?!\\s*(?:とは|って|の(?:意味|設定|チャンネル|ゲーム|配信|動画|基準|タグ|マーク)|チャンネル|設定))|(?:--|[—–―]{1,2}|[ー－]{2})(${DIRECTIVE_ALIASES})(?=\\s|$))\\s*`,
  'i'
)
const TRAILING_DIRECTIVE_PATTERN = new RegExp(
  `(?:^|\\s+)(?:(?:(?:--|[—–―]{1,2}|[ー－]{2})model(?:=|:|\\s+)|-m(?:=|:|\\s+)|model\\s*[:=]\\s*)(\\S+)|\\[model\\s*[:=]\\s*([^\\]]+)\\]|\\[(${BRACKET_DIRECTIVE_ALIASES})\\]|【(?:model\\s*[:=]\\s*)?(${BRACKET_DIRECTIVE_ALIASES})】|(?:--|[—–―]{1,2}|[ー－]{2})(${DIRECTIVE_ALIASES}))\\s*$`,
  'i'
)
const GEMINI_DIRECTIVE_ALIASES = {
  flash: 'gemini-3.8-flash',
  lite: 'gemini-3.5-flash-lite',
  hydrogen: 'gemini-4-hydrogen',
  argon: 'gemini-4-argon',
  neon: 'gemini-4-neon',
  carbon: 'gemini-4-carbon'
}

function normalizeDirectiveValue (raw) {
  const normalized = String(raw || '')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[—–―ー－]/g, '-')
    .trim()
  if (/^(?:r-?18|18禁|nsfw)$/i.test(normalized)) return 'r18'
  return normalized
}

function parseModelDirective (text) {
  if (typeof text !== 'string') return { directive: null, text: '' }
  const halfWidthProbe = text.replace(/[０-９Ａ-Ｚａ-ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  const leading = halfWidthProbe.match(LEADING_DIRECTIVE_PATTERN)
  if (leading) {
    const prefixMentions = text.slice(0, (leading[1] || '').length).trim()
    const raw = normalizeDirectiveValue(leading[2] || leading[3] || leading[4] || leading[5] || leading[6] || '')
    const after = text.slice(leading[0].length).trim()
    const rest = [prefixMentions, after].filter(Boolean).join(' ').trim()
    return { directive: raw || null, text: rest }
  }
  const trailing = halfWidthProbe.match(TRAILING_DIRECTIVE_PATTERN)
  if (trailing) {
    const raw = normalizeDirectiveValue(trailing[1] || trailing[2] || trailing[3] || trailing[4] || trailing[5] || '')
    const rest = text.slice(0, text.length - trailing[0].length).trim()
    return { directive: raw || null, text: rest }
  }
  return { directive: null, text }
}

const MAX_THREAD_MODEL_MEMORY = 500
const threadModelMemory = new Map()

function rememberThreadModel (messageIds, contents) {
  if (!contents || !Array.isArray(messageIds)) return
  let directive = null
  if (contents.uncensored) {
    if (!contents.directUncensored && !contents.uncensoredR18Mode && !contents.explicitUncensoredModel) return
    if (contents.explicitUncensoredModel) directive = contents.explicitUncensoredModel
    else directive = contents.uncensoredR18Mode ? '2' : '1'
  } else if (contents.deep) {
    directive = 'deep'
  }
  if (!directive) return
  const entry = { directive, explicit: Boolean(contents.explicitDirective) }
  for (const id of messageIds) {
    if (!id) continue
    if (threadModelMemory.has(id)) threadModelMemory.delete(id)
    else if (threadModelMemory.size >= MAX_THREAD_MODEL_MEMORY) {
      threadModelMemory.delete(threadModelMemory.keys().next().value)
    }
    threadModelMemory.set(id, entry)
  }
}

const DEBUG_FOOTER_PATTERN = /(?:\r?\n|^)-#\s*(?:model:\s*[^\r\n]+|tokens:\s*in\s+[^\r\n]+)/g

function stripDebugFooterLines (text) {
  if (typeof text !== 'string') return ''
  return text.replace(DEBUG_FOOTER_PATTERN, '').trimEnd()
}

function extractReferencedDirectiveInfo (referenced) {
  if (!referenced) return null
  if (typeof referenced.text === 'string' && referenced.text.trim()) {
    const lines = referenced.text.split(/\r?\n/)
    let canUseDirective = true
    const explicitCandidates = []
    const footerCandidates = []
    for (const line of lines) {
      const footerMatch = line.match(/^-#\s*model:\s*(.+?)\s*·/)
      if (footerMatch) {
        const lastModel = footerMatch[1].split('→').pop().replace(/\s*\(flex\)\s*$/i, '').trim()
        if (lastModel && !/^gemini-/i.test(lastModel)) footerCandidates.push(lastModel)
        continue
      }
      const msgMatch = line.match(/^\[[^\]]+\]\s+([^:]+):\s*(.*)$/)
      if (msgMatch) {
        canUseDirective = msgMatch[1].includes('（依頼者）')
      }
      if (!canUseDirective) continue
      const body = (msgMatch ? msgMatch[2] : line).replace(/<@!?[\w-]+>|<@&[\w-]+>/g, '').trim()
      if (!body) continue
      const parsed = parseModelDirective(body)
      if (parsed.directive) explicitCandidates.push(parsed.directive)
    }
    if (explicitCandidates.length) return { directive: explicitCandidates[explicitCandidates.length - 1], explicit: true }
    if (Array.isArray(referenced.messageIds)) {
      for (let i = referenced.messageIds.length - 1; i >= 0; i--) {
        const remembered = threadModelMemory.get(referenced.messageIds[i])
        if (remembered) return typeof remembered === 'string' ? { directive: remembered, explicit: false } : remembered
      }
    }
    if (typeof referenced.lastBotModel === 'string' && referenced.lastBotModel.trim() && !/^gemini-/i.test(referenced.lastBotModel.trim())) {
      return { directive: referenced.lastBotModel.trim(), explicit: false }
    }
    if (footerCandidates.length) return { directive: footerCandidates[footerCandidates.length - 1], explicit: false }
    return null
  }
  if (Array.isArray(referenced.messageIds)) {
    for (let i = referenced.messageIds.length - 1; i >= 0; i--) {
      const remembered = threadModelMemory.get(referenced.messageIds[i])
      if (remembered) return typeof remembered === 'string' ? { directive: remembered, explicit: false } : remembered
    }
  }
  if (typeof referenced.lastBotModel === 'string' && referenced.lastBotModel.trim() && !/^gemini-/i.test(referenced.lastBotModel.trim())) {
    return { directive: referenced.lastBotModel.trim(), explicit: false }
  }
  return null
}

function extractReferencedDirective (referenced) {
  return extractReferencedDirectiveInfo(referenced)?.directive || null
}

function uncensoredEnvModel () {
  const m = String(process.env.UNCENSORED_MODEL || '').trim()
  return m && m.toLowerCase() !== 'auto' ? m : null
}

function uncensoredR18EnvModel () {
  const m = String(process.env.UNCENSORED_R18_MODEL || '').trim()
  return m && m.toLowerCase() !== 'auto' ? m : null
}

function isAllowedUncensoredModelName (directive) {
  const normalized = normalizeDirectiveValue(directive)
  if (!normalized) return false
  const custom = normalizeLocalModelId(normalized)
  const rawLower = normalized.toLowerCase()
  const customLower = custom.toLowerCase()
  const known = [
    uncensoredBaseModel(),
    uncensoredR18Model(),
    uncensoredEnvModel(),
    uncensoredR18EnvModel(),
    uncensoredState.detectedModel,
    uncensoredState.detectedR18Model
  ].filter(Boolean)
  if (known.some(m => {
    const ml = String(m).trim().toLowerCase()
    const nl = normalizeLocalModelId(m).toLowerCase()
    return rawLower === ml || customLower === ml || customLower === nl
  })) {
    return true
  }
  const endpoint = uncensoredEndpoint()
  if (!endpoint || endpoint.gateway || !isLocalUncensoredUrl(endpoint.url)) return false
  return /^[a-z0-9][a-z0-9._:/-]*$/i.test(custom) && /(?:[-_./:]|gguf|heretic|deckard|uncensored|llama|gemma|qwen|mistral|deepseek)/i.test(custom)
}

function isDirectiveUncensoredValue (directive) {
  if (!directive) return false
  const normalized = normalizeDirectiveValue(directive)
  const lower = normalized.toLowerCase()
  if (lower === 'deep' || lower === 'argon' || GEMINI_DIRECTIVE_ALIASES[lower] || /^gemini-/i.test(normalized)) return false
  if (lower === '1' || lower === 'uncensored' || lower === 'fallback' || lower === 'heretic' || lower === '2' || lower === 'r18' || lower === 'deckard') {
    return true
  }
  return isAllowedUncensoredModelName(normalized)
}

function isR18ModelDirective (directive) {
  const lower = normalizeDirectiveValue(directive).toLowerCase()
  if (lower === '2' || lower === 'r18' || lower === 'deckard' || /deckard|r-?18|uncensored-thinking/i.test(lower)) return true
  const custom = normalizeLocalModelId(directive).toLowerCase()
  const baseLower = uncensoredBaseModel().toLowerCase()
  const r18Lower = uncensoredR18Model().toLowerCase()
  return r18Lower !== baseLower && custom === r18Lower
}

function resolveReferencedDirective (request, referenced = null, decision = null) {
  const info = extractReferencedDirectiveInfo(referenced)
  if (!info?.directive) return null
  if (!isDirectiveUncensoredValue(info.directive)) return info.directive
  const req = String(request || '').trim()
  if (decision?.intent && decision.intent !== 'chat') return null
  if (isLookupOrMetaQuestion(req) || isImageGenerationRequest(req)) return null
  const isCont = CONTINUATION_REQUEST_PATTERN.test(req)
  if (decision && !decision.isR18 && decision.isStory === false && !isCont) return null
  const wantsStory = typeof decision?.isStory === 'boolean'
    ? decision.isStory
    : STORY_OR_SCENE_REQUEST_PATTERN.test(req)
  if (info.explicit) {
    const keepsExplicit = !req || isCont || wantsStory || !!decision?.isR18 || isR18Text(req)
    return keepsExplicit ? info.directive : null
  }
  if (isR18ModelDirective(info.directive) && wantsStory && (!decision || decision.isR18)) {
    return info.directive
  }
  return isCont ? info.directive : null
}

function isUncensoredDirective (request, referenced = null, decision = null) {
  const refText = typeof referenced === 'string' ? referenced : referenced?.text
  if (mentionsMinor(request, refText) || isUnsafeMinorContent(request) || isUnsafeMinorContent(refText)) return false
  const explicit = parseModelDirective(request).directive
  if (explicit) return isDirectiveUncensoredValue(explicit)
  return isDirectiveUncensoredValue(resolveReferencedDirective(request, referenced, decision))
}

function applyModelDirective (contents, directive, { inherited = false } = {}) {
  if (!directive || !contents) return false
  const normalized = normalizeDirectiveValue(directive)
  const lower = normalized.toLowerCase()
  if (lower === 'deep') {
    if (deepModel()) {
      contents.deep = true
      contents.uncensored = false
      contents.explicitDirective = !inherited
      return true
    }
    return false
  }
  if (GEMINI_DIRECTIVE_ALIASES[lower] || /^gemini-/i.test(normalized)) {
    const canonical = (GEMINI_DIRECTIVE_ALIASES[lower] || normalized).toLowerCase()
    if (isImageModel(canonical)) return false
    const deep = deepModel()
    if (deep && canonical === deep.toLowerCase()) {
      contents.deep = true
      contents.uncensored = false
      contents.explicitDirective = !inherited
      return true
    }
    if (!GEMINI_DIRECTIVE_ALIASES[lower] && !REPLY_MODELS.includes(canonical)) return false
    contents.model = canonical
    contents.deep = false
    contents.uncensored = false
    contents.explicitDirective = !inherited
    return true
  }
  const allowUncensored = contents.uncensoredR18 !== false && !contents.safetyFilter && !contents.minorTerm
  if (!isUncensoredConfigured() || !allowUncensored) return false
  if (lower === '1' || lower === 'uncensored' || lower === 'fallback' || lower === 'heretic') {
    contents.deep = false
    contents.uncensored = true
    contents.directUncensored = true
    contents.uncensoredR18Mode = false
    contents.explicitUncensoredModel = null
    contents.inheritedUncensoredModel = false
    contents.explicitDirective = !inherited
    return true
  }
  if (lower === '2' || lower === 'r18' || lower === 'deckard') {
    contents.deep = false
    contents.uncensored = true
    contents.directUncensored = true
    contents.uncensoredR18Mode = true
    contents.explicitUncensoredModel = null
    contents.inheritedUncensoredModel = false
    contents.explicitDirective = !inherited
    return true
  }
  if (!isAllowedUncensoredModelName(normalized)) return false
  const custom = normalizeLocalModelId(normalized)
  const customLower = custom.toLowerCase()
  const baseLower = uncensoredBaseModel().toLowerCase()
  const r18Lower = uncensoredR18Model().toLowerCase()
  if (r18Lower !== baseLower && customLower === r18Lower) {
    contents.deep = false
    contents.uncensored = true
    contents.directUncensored = true
    contents.uncensoredR18Mode = true
    contents.explicitUncensoredModel = null
    contents.inheritedUncensoredModel = false
    contents.explicitDirective = !inherited
    return true
  }
  if (customLower === baseLower) {
    contents.deep = false
    contents.uncensored = true
    contents.directUncensored = true
    contents.uncensoredR18Mode = false
    contents.explicitUncensoredModel = null
    contents.inheritedUncensoredModel = false
    contents.explicitDirective = !inherited
    return true
  }
  require('../utils/geminiPrices').registerUncensoredModel(custom)
  contents.deep = false
  contents.uncensored = true
  contents.directUncensored = true
  contents.explicitUncensoredModel = custom
  contents.inheritedUncensoredModel = !!inherited
  contents.explicitDirective = !inherited
  if (/deckard|r-?18|uncensored-thinking/i.test(custom)) contents.uncensoredR18Mode = true
  return true
}

const HAND_OVER_R18_DECLARATION = prompts.tool('hand_over_r18', {
  parameters: {
    type: 'OBJECT',
    properties: {
      reason: { type: 'STRING' },
      image_description: { type: 'STRING' }
    },
    required: ['reason']
  }
})

const R18_PATTERN = /(?:^|[^a-z0-9])(?:r-?18|nsfw)(?:$|[^a-z0-9])|18禁|成人向け|アダルト|官能(?:小説|的)?|エロ(?:小説|ss|話|ネタ|画像|会話|台詞|セリフ|展開|描写|プレイ|ゲー|動画|本|漫画|同人)|えっち(?:な|しよ|して|しよう)|エッチ(?:な|しよ|して|しよう)|濡れ場|(?:肌|身体|体)を重ね|セックス|性行為|性交|交尾|中出し|射精|絶頂|オーガズム|オナニー|自慰|フェラ(?:チオ)?|パイズリ|手コキ|足コキ|素股|潮吹き|愛液|勃起|ちんこ|ちんぽ|チンポ|まんこ|マンコ|おまんこ|クリトリス|アナル|淫語|喘ぎ(?:声)?|凌辱|調教|輪姦|レイプ|催眠エロ|触手(?:責め|プレイ)|全裸|裸に|服を脱が|下着を脱/i
function isR18Text (...texts) {
  return texts.some(t => typeof t === 'string' && R18_PATTERN.test(t))
}

// Phrases that unmistakably ask the bot to write explicit adult fiction / scenes rather than merely
// mentioning R18/NSFW terms in a joke, setting question, or video/game lookup.
const EXPLICIT_R18_PATTERN = /(?:(?:^|[^a-z0-9])r-?18(?:$|[^a-z0-9])|18禁|成人向け|アダルト|エロ|官能|えっちな|エッチな)[\sの・]*(?:小説|ss|物語|お話|ストーリー|シナリオ|脚本|創作|官能小説|濡れ場|(?:シーン|場面|描写|展開|パート)(?:[をにへも]|と?して)?[^\n。！？!?]{0,12}(?:書いて|描いて|変えて|変更|して|入れて|お願い|作って))|官能小説|(?:濡れ場|性行為|性交|中出し|フェラ(?:チオ)?|パイズリ|手コキ|足コキ|素股|潮吹き|凌辱|輪姦|催眠エロ|触手(?:責め|プレイ))[\sの]*(?:小説|ss|物語|お話|シーン|場面|描写|展開)(?:[をにへもで]|お願い|書いて|描いて|変えて|して)?/i
const isExplicitR18Text = (...texts) => texts.some(t => typeof t === 'string' && EXPLICIT_R18_PATTERN.test(t))

const CONTINUATION_REQUEST_PATTERN = /続き|続編|その先|その後|(?:もっと|さらに|そのまま|そこから)(?:激しく|濃く|詳しく|甘く|えっちに|エロく|奥まで)?\s*(?:書いて|描いて|続け|お願い|ちょうだい|見せて|聞かせて|[！!。…\s]*$)|書き直|別の展開/i
const STORY_OR_SCENE_REQUEST_PATTERN = new RegExp(
  `小説|ss|物語|お話|ストーリー|シナリオ|脚本|創作|ライトノベル|ラノベ|地の文|官能|濡れ場|(?:シーン|場面|展開|描写|パート)(?:[をにへも]|と?して)?[^\\n。！？!?]{0,12}(?:書いて|描いて|変えて|変更|して|入れて|足して|追加|続け|お願い|作って)|${CONTINUATION_REQUEST_PATTERN.source}`,
  'i'
)
const LOOKUP_OR_META_QUESTION_PATTERN = /(?:動画|配信|アーカイブ|切り抜き|生放送|youtube|twitch|steam|実績|プレイ時間|レビュー|ウィッシュリスト|チャンネル|サーバー|ルール|イベント|フォーラム|スレッド|wiki|コマンド|モデル|設定)[^\n]{0,30}(?:教え|調べ|探し|どれ|いつ|どこ|誰|だれ|何|なに|なんの|どう|なぜ|なんで|いくら|ある|ありま|見せて|一覧|まとめ|おすすめ|オススメ|[?？])|(?:とは|ってなに|って何|どういう意味)[?？。！!\s]*$/i
const IMAGE_GENERATION_REQUEST_PATTERN = /(?:画像|イラスト|絵|写真|アイコン|サムネ(?:イル)?)を?\s*(?:作って|描いて|生成|書いて|お願い|くれ|ちょうだい)|(?:絵|イラスト)を?描いて/i

function isLookupOrMetaQuestion (text) {
  const s = String(text || '')
  return LOOKUP_OR_META_QUESTION_PATTERN.test(s) && !/小説|ss|物語|お話|シナリオ|脚本|官能小説|濡れ場/i.test(s)
}

function isImageGenerationRequest (text) {
  const s = String(text || '')
  return IMAGE_GENERATION_REQUEST_PATTERN.test(s) && !/小説|ss|物語|お話/i.test(s)
}

// How sure the decision model has to be to send a story/scene request to the uncensored model on
// its own, without a word of R18_PATTERN (GEMINI_DECISION_R18_ROUTE_THRESHOLD, 0-1).
const DEFAULT_R18_ROUTE_THRESHOLD = 0.85
function r18RouteThreshold () {
  const n = Number(process.env.GEMINI_DECISION_R18_ROUTE_THRESHOLD)
  return process.env.GEMINI_DECISION_R18_ROUTE_THRESHOLD && n > 0 && n <= 1 ? n : DEFAULT_R18_ROUTE_THRESHOLD
}

// Whether a request goes to the uncensored model before Gemini sees it (`route`, with why), and
// whether it may be handed over if Gemini refuses or is blocked (`maybe`). Going first is reserved
// strictly for explicit R18 creative writing requests (or continuations of one): ordinary jokes,
// banter, image requests, and video/game/server lookups always go to Gemini first.
function r18Route ({ request, referenced = null, decision = null }) {
  const req = String(request || '')
  const ref = typeof referenced === 'string' ? referenced : referenced?.text
  if (mentionsMinor(req, ref) || isUnsafeMinorContent(req) || isUnsafeMinorContent(ref)) {
    return { route: false, why: null, maybe: false, disallowHandover: true }
  }
  const nonChatIntent = Boolean(decision?.intent && decision.intent !== 'chat')
  const lookupAsk = isLookupOrMetaQuestion(req)
  const imageAsk = isImageGenerationRequest(req)
  const isCont = CONTINUATION_REQUEST_PATTERN.test(req)
  const wantsStory = typeof decision?.isStory === 'boolean'
    ? (decision.isStory || isCont)
    : STORY_OR_SCENE_REQUEST_PATTERN.test(req)
  const decisionSays = !!decision?.isR18
  const sure = Number.isFinite(decision?.r18Prob) && decision.r18Prob >= r18RouteThreshold()
  let why = null
  if (!nonChatIntent && !lookupAsk && !imageAsk) {
    if (isExplicitR18Text(req)) why = 'explicit R18 writing request'
    else if (wantsStory && decisionSays && (isR18Text(req) || (isCont && isR18Text(ref)))) why = `R18 story and decision (p=${decision.r18Prob.toFixed(2)})`
    else if (wantsStory && sure) why = `decision R18 story (p=${decision.r18Prob.toFixed(2)})`
  }
  let maybe
  if (nonChatIntent || lookupAsk) {
    maybe = false
  } else if (why || decisionSays) {
    maybe = true
  } else if (decision) {
    maybe = false
  } else {
    maybe = (isR18Text(req) || (isCont && isExplicitR18Text(ref))) ? true : null
  }
  return { route: !!why, why, maybe, disallowHandover: nonChatIntent || lookupAsk }
}

const REFUSAL_REPLY_PATTERN = /(?:性的|成人向け|アダルト|r-?18|18禁|露骨な描写|不適切|ポリシー|ガイドライン|安全上の理由)[\s\S]{0,60}(?:お応えでき|答えられ|書けま|作成でき|対応でき|控えさせて|お断り)|(?:お応えでき|答えられ|書けま|作成でき|対応でき)(?:ません|かねます)[\s\S]{0,40}(?:性的|成人向け|アダルト|r-?18|18禁|露骨|ポリシー|ガイドライン)|(?:朝の光|朝日|翌朝)[\s\S]{0,80}乱れたシーツ|乱れたシーツ[\s\S]{0,80}(?:朝の光|朝日|翌朝)/i
function isRefusalReply (text) {
  return typeof text === 'string' && REFUSAL_REPLY_PATTERN.test(text)
}

// A refusal on the grounds that the request is sexual, or a fade-out of what was asked for. The
// other refusals of REFUSAL_REPLY_PATTERN (不適切, ポリシー, ガイドライン, 安全上の理由) are as often
// about something dangerous or hateful.
const SEXUAL_REFUSAL_PATTERN = /(?:性的|成人向け|アダルト|r-?18|18禁|露骨な描写)[\s\S]{0,60}(?:お応えでき|答えられ|書けま|作成でき|対応でき|控えさせて|お断り)|(?:お応えでき|答えられ|書けま|作成でき|対応でき)(?:ません|かねます)[\s\S]{0,40}(?:性的|成人向け|アダルト|r-?18|18禁|露骨)|(?:朝の光|朝日|翌朝)[\s\S]{0,80}乱れたシーツ|乱れたシーツ[\s\S]{0,80}(?:朝の光|朝日|翌朝)/i

// What kind of refusal a reply is: 'sexual' (by SEXUAL_REFUSAL_PATTERN, or sokudan when checking a
// story / R18 candidate), 'other' (any other refusal of REFUSAL_REPLY_PATTERN), or null.
async function refusalKind (text, { checkSokudan = true, requestText = '' } = {}) {
  if (typeof text !== 'string') return null
  if (SEXUAL_REFUSAL_PATTERN.test(text)) return 'sexual'
  if (checkSokudan && sokudan.canDecide() && (await sokudan.detectRefusalReply(text, requestText)).refused) return 'sexual'
  return isRefusalReply(text) ? 'other' : null
}

async function isRefusalReplyAsync (text, requestText = '') {
  if (isRefusalReply(text)) return true
  if (!sokudan.canDecide()) return false
  const res = await sokudan.detectRefusalReply(text, requestText)
  return !!res?.refused
}

const STORY_REQUEST_PATTERN = /小説|ss|物語|お話|ストーリー|シナリオ|脚本|創作|ライトノベル|ラノベ|地の文|官能|濡れ場|えっち|エッチ|続き|書いて|執筆/i

// story: a story was asked for (isStoryRequest); otherwise the rules are those of a chat reply.
// settings: the server's way of speaking and reply length (serverSettings), left out for a story,
// which goes by the uncensored model's own rules for style and length.
// style: the streamer's synthesized speaking-style profile and compact exemplars (streamerStyle),
// included for non-story streamerPersona chat replies even when compact mode strips server info.
function uncensoredSystemInstruction ({ compact = false, r18Mode = false, story = false, settings = '', style = '', streamerPersona = true, model = null } = {}) {
  const streamerMode = streamerPersona !== false
  const rules = prompts.render('chat/uncensored/rules', { r18Mode, compact, story })
  const chat = story ? '' : settings
  const personaStyle = (story || !streamerMode) ? '' : style
  if (compact) {
    const persona = streamerMode ? (process.env.CHAT_PERSONA || '').trim() : ''
    return [
      prompts.render('chat/uncensored/role'),
      ...(persona ? ['', '## 運営者が設定したキャラクター', persona] : []),
      ...(chat ? ['', chat] : []),
      ...(personaStyle ? ['', personaStyle] : []),
      '',
      rules
    ].join('\n')
  }
  return [
    systemInstruction({ uncensored: true, settings: chat, streamerPersona, model }),
    ...(personaStyle ? ['', personaStyle] : []),
    '',
    rules
  ].join('\n')
}

const MAX_UNCENSORED_CONVERSATION_CHARS = 1800
const MAX_UNCENSORED_RECENT_CHARS = 400
const MAX_UNCENSORED_MEMBERS_CHARS = 250

// Whether a story was asked for, as sokudan judged the request (draft); null when it gave no
// answer, and the words of the request decide (STORY_REQUEST_PATTERN).
function asksForStory (contents) {
  const answer = contents?.sokudanDecision?.isStory
  return typeof answer === 'boolean' ? answer : null
}

// What was asked, in a request as buildPrompt writes it: the request and the conversation it
// replies to, without their headings. The server's settings before them are left out: they name
// stories too (the reply lengths), which made every request look like one for a story.
function askedIn (text) {
  const at = text.search(/(?:^|\n)## 依頼メッセージ/)
  return (at === -1 ? text : text.slice(at)).split('\n').filter(line => !line.startsWith('## ')).join('\n')
}

// Whether the uncensored model is to write a story: as sokudan read the request (`story`), or
// else by the words of the request and the conversation it replies to. Not because the request is
// R18 or the model is the R18 one: a chat reply keeps the server's reply length.
function isStoryRequest (text, story = null) {
  return typeof story === 'boolean' ? story : STORY_REQUEST_PATTERN.test(askedIn(String(text || '')))
}

function compactUncensoredText (text, { story = null } = {}) {
  if (typeof text !== 'string') return ''
  const hasConversation = /<untrusted source="conversation">/.test(text)
  const storyMode = isStoryRequest(text, story)
  let out = text
    .replace(/\n## このサーバーの情報（最新）\n<untrusted source="server">[\s\S]*?<\/untrusted>/, '')
    .replace(/\n## 依頼や会話に出てくるチャンネル[\s\S]*?(?=\n## |\n依頼されたチャンネル:)/, '')
    .replace(/\n現在日時: [^\n]+/, '')
    .replace(/(<untrusted source="members">\n?)([\s\S]*?)(\n?<\/untrusted>)/, (whole, open, body, close) =>
      body.length > MAX_UNCENSORED_MEMBERS_CHARS ? `${open}${body.slice(0, MAX_UNCENSORED_MEMBERS_CHARS)}${close}` : whole
    )
  if (hasConversation) {
    out = out
      .replace(/\n## 依頼されたチャンネルの最近の会話[\s\S]*?<\/untrusted>/, '')
      .replace(/(<untrusted source="conversation">\n?)([\s\S]*?)(\n?<\/untrusted>)/, (whole, open, body, close) =>
        body.length > MAX_UNCENSORED_CONVERSATION_CHARS ? `${open}${body.slice(-MAX_UNCENSORED_CONVERSATION_CHARS)}${close}` : whole
      )
  } else {
    out = out.replace(/(<untrusted source="recent">\n?)([\s\S]*?)(\n?<\/untrusted>)/, (whole, open, body, close) =>
      body.length > MAX_UNCENSORED_RECENT_CHARS ? `${open}${body.slice(-MAX_UNCENSORED_RECENT_CHARS)}${close}` : whole
    )
  }
  out = out.replace(/<\/?untrusted(?:\s+source="[^"]*")?>\n?/g, '').replace(/^\n+/, '')
  if (storyMode) {
    out += `\n\n${prompts.render('chat/uncensored/story-note')}`
  }
  return out.replace(/\n{3,}/g, '\n\n')
}

function isLocalUncensoredUrl (url) {
  return /\.railway\.internal\b|\.run\.app\b|\.trycloudflare\.com\b|\.ngrok(?:-free)?\.(?:app|io|dev)\b|\/\/(?:localhost|127\.0\.0\.1|\[::1?\])(?::|\/|$)/i.test(String(url || ''))
}

function uncensoredEndpoint () {
  const slug = String(process.env.UNCENSORED_GATEWAY_PROVIDER || '').trim()
  if (slug && isGatewayConfigured()) return { url: gatewayURL(`custom-${slug}/v1/chat/completions`), gateway: true }
  const raw = String(process.env.UNCENSORED_API_URL || '').trim()
  if (!raw) return null
  const base = (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, '')
  const url = /\/chat\/completions$/i.test(base)
    ? base
    : /\/v1(?:thinking)?$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
  return { url, gateway: false }
}

function isUncensoredConfigured () {
  return !!uncensoredEndpoint()
}

const UNCENSORED_CHECK_TIMEOUT_MS = 60 * 1000
const UNCENSORED_MODELS_TIMEOUT_MS = 10 * 1000
const UNCENSORED_RETRY_INTERVAL_MS = 60 * 1000
const UNCENSORED_MAX_STARTUP_CHECKS = 20
const uncensoredState = { usable: null, url: null, checkedAt: 0, error: null }

function isUncensoredUsable () {
  const endpoint = uncensoredEndpoint()
  if (!endpoint) return false
  if (uncensoredState.url === endpoint.url && uncensoredState.usable === false) {
    if (uncensoredState.checkedAt && Date.now() - uncensoredState.checkedAt < UNCENSORED_RETRY_INTERVAL_MS) return false
  }
  return true
}

function uncensoredHeaders (endpoint) {
  const headers = { 'Content-Type': 'application/json', ...(endpoint.gateway ? gatewayAuthHeaders() : {}) }
  if (process.env.UNCENSORED_API_KEY) headers.Authorization = `Bearer ${process.env.UNCENSORED_API_KEY}`
  if (endpoint.gateway && process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS) headers['cf-aig-byok-alias'] = process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS
  return headers
}

function updateDetectedModelsFromList (list) {
  if (!Array.isArray(list) || !list.length) return
  const ids = list
    .map(m => (typeof m?.id === 'string' ? m.id.trim() : (typeof m?.name === 'string' ? m.name.trim() : '')))
    .filter(Boolean)
  if (!ids.length) return
  const register = require('../utils/geminiPrices').registerUncensoredModel
  ids.forEach(id => register(id))
  const r18Candidate = ids.length > 1
    ? (ids.find(id => /deckard|r-?18|uncensored-thinking/i.test(id)) || ids[1])
    : null
  const baseCandidate = (r18Candidate && ids.find(id => id !== r18Candidate)) || ids[0]
  if (baseCandidate) uncensoredState.detectedModel = baseCandidate
  if (r18Candidate) uncensoredState.detectedR18Model = r18Candidate
}

// Probes the uncensored endpoint at startup (and after a failure) so the logs show right away
// whether it can be reached and the model is loaded. For direct OpenAI-compatible servers
// (such as llama-server on Railway or Cloud Run GPU), it first checks GET /v1/models which
// responds without running inference; if that returns 404/405 (or on AI Gateway), it falls back
// to a 1-token POST /v1/chat/completions.
async function checkUncensoredConnection ({ timeoutMs = UNCENSORED_CHECK_TIMEOUT_MS, notifyWarn = true, notifyWebhook = true } = {}) {
  const endpoint = uncensoredEndpoint()
  if (!endpoint) {
    uncensoredState.usable = null
    uncensoredState.url = null
    global.logger?.info('[UNCENSORED]: Not configured (set UNCENSORED_API_URL to enable uncensored / R18 fallback)')
    return { configured: false, usable: false }
  }
  const model = uncensoredModel()
  try {
    let verified = false
    if (!endpoint.gateway && /\/chat\/completions$/.test(endpoint.url)) {
      const modelsUrl = endpoint.url.replace(/\/chat\/completions$/, '/models')
      const probeTimeout = isLocalUncensoredUrl(endpoint.url) ? timeoutMs : Math.min(timeoutMs, UNCENSORED_MODELS_TIMEOUT_MS)
      const modelsRes = await fetch(modelsUrl, {
        method: 'GET',
        headers: uncensoredHeaders(endpoint),
        signal: AbortSignal.timeout(probeTimeout),
        dispatcher: dispatcherFor(probeTimeout)
      })
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json()
        const list = Array.isArray(modelsData?.data) ? modelsData.data : (Array.isArray(modelsData?.models) ? modelsData.models : null)
        if (list || Array.isArray(modelsData?.choices)) {
          verified = true
          if (list) updateDetectedModelsFromList(list)
        }
      } else if (modelsRes.status !== 404 && modelsRes.status !== 405) {
        const text = (await modelsRes.text().catch(() => '')).slice(0, 300)
        throw new Error(`HTTP ${modelsRes.status}${text ? ` ${text}` : ''}`)
      }
    }
    if (!verified) {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: uncensoredHeaders(endpoint),
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: dispatcherFor(timeoutMs),
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          temperature: 0
        })
      })
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300)
        throw new Error(`HTTP ${res.status}${text ? ` ${text}` : ''}`)
      }
      const data = await res.json()
      if (!Array.isArray(data?.choices) || data.choices.length === 0) {
        throw new Error(`Unexpected response: ${JSON.stringify(data).slice(0, 300)}`)
      }
    }
    const activeModel = uncensoredModel()
    uncensoredState.usable = true
    uncensoredState.url = endpoint.url
    uncensoredState.checkedAt = Date.now()
    uncensoredState.error = null
    const msg = `[UNCENSORED]: Connected and ready (${activeModel} at ${endpoint.url})`
    global.logger?.info(msg)
    if (notifyWebhook) global.webhook?.generic?.(msg)
    return { configured: true, usable: true, model: activeModel, url: endpoint.url }
  } catch (e) {
    const reason = (e?.message || String(e)).slice(0, 300)
    uncensoredState.usable = false
    uncensoredState.url = endpoint.url
    uncensoredState.checkedAt = Date.now()
    uncensoredState.error = reason
    const msg = `[UNCENSORED]: Startup check failed for ${model} (${endpoint.url}): ${reason} — R18 / uncensored fallback is disabled until it responds`
    global.logger?.warn(msg)
    if (notifyWebhook && notifyWarn) global.webhook?.warn?.(msg)
    return { configured: true, usable: false, model, url: endpoint.url, error: reason }
  }
}

function startUncensoredCheck ({ notifyWebhook = true } = {}) {
  const endpoint = uncensoredEndpoint()
  if (endpoint && process.env.UNCENSORED_SKIP_STARTUP_PROBE === 'true') {
    const model = uncensoredModel()
    uncensoredState.usable = true
    uncensoredState.url = endpoint.url
    uncensoredState.checkedAt = Date.now()
    uncensoredState.error = null
    global.logger?.info(`[UNCENSORED]: Configured (${model} at ${endpoint.url}); startup probe skipped (UNCENSORED_SKIP_STARTUP_PROBE=true)`)
    return Promise.resolve({ configured: true, usable: true, skipped: true, model, url: endpoint.url })
  }
  let attempts = 0
  const run = async () => {
    attempts++
    const res = await checkUncensoredConnection({ notifyWarn: attempts === 1, notifyWebhook })
    if (res.configured && !res.usable && attempts < UNCENSORED_MAX_STARTUP_CHECKS) {
      const timer = setTimeout(run, UNCENSORED_RETRY_INTERVAL_MS)
      timer.unref?.()
    }
  }
  return run()
}

function toJsonSchema (schema) {
  if (!schema || typeof schema !== 'object') return schema
  const out = { ...schema }
  if (typeof out.type === 'string') out.type = out.type.toLowerCase()
  if (out.properties) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, toJsonSchema(v)]))
  }
  if (out.items) out.items = toJsonSchema(out.items)
  return out
}

function toOpenAITools (declarations, allowed = null) {
  const active = allowed ? declarations.filter(d => allowed.includes(d.name)) : declarations
  return active.map(d => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: toJsonSchema(d.parameters)
    }
  }))
}

function extractLookupNotes (turns) {
  const notes = []
  for (const turn of turns) {
    for (const p of turn.parts || []) {
      if (p.functionResponse?.response) {
        const raw = JSON.stringify(p.functionResponse.response)
        if (raw && raw !== '{}') notes.push(`- ${p.functionResponse.name}: ${raw.slice(0, 800)}`)
      }
    }
  }
  return notes.join('\n').slice(0, 2500)
}

function toOpenAIMessages (system, contents, { compact = false, r18Mode = false } = {}) {
  const messages = [{ role: 'system', content: system }]
  let pendingCallIds = []
  let appendedImageDesc = false
  let appendedLookupNotes = false
  for (const turn of contents) {
    const parts = turn.parts || []
    if (turn.role === 'model') {
      const text = parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('\n')
      const calls = parts.filter(p => p.functionCall)
      pendingCallIds = calls.map((p, i) => `call_${i}_${p.functionCall.name}`)
      const msg = { role: 'assistant', content: text || null }
      if (calls.length) {
        msg.tool_calls = calls.map((p, i) => ({
          id: pendingCallIds[i],
          type: 'function',
          function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) }
        }))
      }
      messages.push(msg)
      continue
    }
    const responses = parts.filter(p => p.functionResponse)
    responses.forEach((p, i) => {
      const id = pendingCallIds[i] || `call_${i}_${p.functionResponse.name}`
      messages.push({
        role: 'tool',
        tool_call_id: id,
        name: p.functionResponse.name,
        content: JSON.stringify(p.functionResponse.response ?? {})
      })
    })
    const visionEnabled = !compact || process.env.UNCENSORED_VISION === 'true'
    const other = parts.filter(p => !p.functionResponse && !p.thought && (visionEnabled || !p.inlineData))
    if (other.length) {
      const hasImages = visionEnabled && other.some(p => p.inlineData)
      if (hasImages) {
        const contentParts = other.map(p => p.inlineData
          ? { type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } }
          : { type: 'text', text: String(p.text || '') })
        if (contents.imageDescription && !appendedImageDesc && !contentParts.some(p => p.type === 'text' && p.text.includes('## 添付・返信先画像の内容（視覚情報）'))) {
          contentParts.push({ type: 'text', text: `## 添付・返信先画像の内容（視覚情報）\n${contents.imageDescription}` })
          appendedImageDesc = true
        }
        if (contents.lookupNotes && !appendedLookupNotes && !contentParts.some(p => p.type === 'text' && p.text.includes('## ツールで調べた関連情報'))) {
          contentParts.push({ type: 'text', text: `## ツールで調べた関連情報\n${contents.lookupNotes}` })
          appendedLookupNotes = true
        }
        messages.push({
          role: 'user',
          content: contentParts
        })
      } else {
        const joined = other.filter(p => typeof p.text === 'string').map(p => p.text).join('\n')
        const baseText = compact ? compactUncensoredText(joined, { story: asksForStory(contents) }) : joined
        let finalContent = baseText
        if (contents.imageDescription && !appendedImageDesc && !finalContent.includes('## 添付・返信先画像の内容（視覚情報）')) {
          finalContent = `${finalContent}\n\n## 添付・返信先画像の内容（視覚情報）\n${contents.imageDescription}`
          appendedImageDesc = true
        }
        if (contents.lookupNotes && !appendedLookupNotes && !finalContent.includes('## ツールで調べた関連情報')) {
          finalContent = `${finalContent}\n\n## ツールで調べた関連情報\n${contents.lookupNotes}`
          appendedLookupNotes = true
        }
        messages.push({ role: 'user', content: finalContent })
      }
    }
  }
  return messages
}

function collapseRepetitions (text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/(.{2,40}?)(?:[、。！？\s]*\1){2,}/gu, '$1')
    .replace(/(.)\1{4,}/gu, '$1$1$1')
}

const CLOSED_THOUGHT_BLOCK_RE = /<\|channel>\s*thought[\s\S]*?<channel\|>|<\|thought\|>[\s\S]*?(?:<channel\|>|<\|thought\|>|<\/thought>)|<think>[\s\S]*?<\/think>|<thought>[\s\S]*?<\/thought>|<\|channel\|>\s*analysis[\s\S]*?(?:<\|channel\|>\s*final\b|<\|message\|>)/gi
const CLOSING_THOUGHT_TAG_RE = /<channel\|>|<\/think>|<\/thought>|<\|channel\|>\s*final\b|<\|message\|>/gi
const OPENING_THOUGHT_TAG_RE = /(?:<\|channel>\s*thought|<\|thought\|>|<think>|<thought>|<\|channel\|>\s*analysis)[\s\S]*$/i
const THOUGHT_PREAMBLE_RE = /^(?:thinking process|thought process|internal monologue|let'?s (?:analyze|break down) the (?:user|request|prompt)|ai bot in a discord server\b|(?:okay,\s*)?the user (?:is asking|wants|asked)\b)/i
const PROMPT_META_BULLET_RE = /^\s*(?:[*+-]|\d+\.)\s+\*{0,2}(?:bot identity|recent chat context|chat context|channel context|user(?:'s)? request|analyze the request|constraints?|persona)\b|(?:not pretending to be the streamer|readable as a discord message|addressing the user)/gim
const JAPANESE_CHAR_RE = /[ぁ-んァ-ヶ一-龠々]/g

function isUnclosedThoughtTrace (text) {
  const s = String(text || '').trim()
  if (!s) return false
  if (THOUGHT_PREAMBLE_RE.test(s)) return true
  const nonWs = s.replace(/\s+/g, '')
  if (!nonWs.length) return false
  const jpCount = (nonWs.match(JAPANESE_CHAR_RE) || []).length
  if (jpCount / nonWs.length < 0.15) {
    const metaMatches = s.match(PROMPT_META_BULLET_RE)
    if (metaMatches && metaMatches.length >= 2) return true
  }
  return false
}

function cleanUncensoredContent (raw, { fromReasoning = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  let s = raw.replace(CLOSED_THOUGHT_BLOCK_RE, '')
  let lastCloseEnd = -1
  for (const m of s.matchAll(CLOSING_THOUGHT_TAG_RE)) {
    lastCloseEnd = m.index + m[0].length
  }
  if (lastCloseEnd !== -1) {
    s = s.slice(lastCloseEnd)
  } else if (fromReasoning) {
    return ''
  }
  s = s
    .replace(OPENING_THOUGHT_TAG_RE, '')
    .replace(/<\|turn\|>[\s\S]*$/i, '')
    .replace(/<(?:turn|eos)\|>|<\|(?:eot_id|im_end|end_of_turn)\|>/gi, '')
    .trim()
  if (isUnclosedThoughtTrace(s)) return ''
  return s
}

function extractUncensoredAnswer (msg) {
  const fromContent = cleanUncensoredContent(msg?.content, { fromReasoning: false })
  if (fromContent) return fromContent
  return cleanUncensoredContent(msg?.reasoning_content, { fromReasoning: true })
}

function parseUncensoredParts (msg, declarations, allowed = null) {
  const parts = []
  for (const tc of msg?.tool_calls || []) {
    const name = tc?.function?.name
    if (!name) continue
    let args = tc.function.arguments || {}
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch (_) { args = {} }
    }
    if (name === SUBMIT_CHAT_DECLARATION.name && typeof args?.text === 'string') {
      args = { ...args, text: collapseRepetitions(args.text) }
    }
    parts.push({ functionCall: { name, args: args && typeof args === 'object' ? args : {} } })
  }
  const stripped = extractUncensoredAnswer(msg)
  if (!parts.length && stripped) {
    for (const m of stripped.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) {
      try {
        const parsed = JSON.parse(m[1])
        if (parsed?.name) {
          const args = typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : (parsed.arguments || parsed.args || {})
          parts.push({ functionCall: { name: parsed.name, args: args && typeof args === 'object' ? args : {} } })
        }
      } catch (_) {}
    }
    const text = collapseRepetitions(stripped.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim())
    const canSubmitChat = (!allowed || allowed.includes(SUBMIT_CHAT_DECLARATION.name)) && declarations.some(d => d.name === SUBMIT_CHAT_DECLARATION.name)
    if (!parts.length && text && canSubmitChat) {
      parts.push({ functionCall: { name: SUBMIT_CHAT_DECLARATION.name, args: { text } } })
    }
  }
  return parts
}

const UNCENSORED_SAMPLING_PARAMS = {
  max_tokens: 4096,
  stream: true,
  stream_options: { include_usage: true },
  top_p: 0.95,
  top_k: 64,
  min_p: 0.05,
  repeat_penalty: 1.02,
  chat_template_kwargs: { enable_thinking: false }
}

function trimIncompleteSentence (text) {
  const s = String(text || '').trim()
  if (!s || /[。！？…」』）)\n]$/.test(s)) return s
  const minCut = Math.floor(s.length * 0.5)
  for (let i = s.length - 1; i >= minCut; i--) {
    if (/[。！？…」』\n]/.test(s[i])) return s.slice(0, i + 1).trim()
  }
  return s
}

async function readUncensoredResponse (res, { softTimeoutMs = 200 * 1000 } = {}) {
  if (!res.body) return res.json()
  const startedAt = Date.now()
  let rawAll = ''
  let buffer = ''
  let content = ''
  let reasoning = ''
  let usage = null
  let sawSse = false
  let cutEarly = false
  const takeLine = line => {
    const m = line.match(/^data:\s*(.*)$/)
    if (!m) return
    sawSse = true
    const payload = m[1].trim()
    if (!payload || payload === '[DONE]') return
    let chunk
    try { chunk = JSON.parse(payload) } catch (_) { return }
    const choice = chunk.choices?.[0]
    if (choice?.delta) {
      if (typeof choice.delta.content === 'string') content += choice.delta.content
      if (typeof choice.delta.reasoning_content === 'string') reasoning += choice.delta.reasoning_content
    } else if (choice?.message) {
      if (typeof choice.message.content === 'string') content += choice.message.content
      if (typeof choice.message.reasoning_content === 'string') reasoning += choice.message.reasoning_content
    }
    if (chunk.usage) {
      usage = chunk.usage
    } else if (chunk.timings && (chunk.timings.prompt_n || chunk.timings.predicted_n)) {
      usage = {
        prompt_tokens: (chunk.timings.prompt_n || 0) + (chunk.timings.cache_n || 0),
        prompt_tokens_details: { cached_tokens: chunk.timings.cache_n || 0 },
        completion_tokens: chunk.timings.predicted_n || 0
      }
    }
  }
  try {
    for await (const text of textChunks(res)) {
      rawAll += text
      buffer += text
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop()
      lines.forEach(takeLine)
      const answerSoFar = extractUncensoredAnswer({ content, reasoning_content: reasoning })
      if (sawSse && answerSoFar.length >= 80 && Date.now() - startedAt >= softTimeoutMs) {
        cutEarly = true
        await res.body.cancel?.().catch(() => {})
        break
      }
    }
    takeLine(buffer)
  } catch (e) {
    const answerSoFar = extractUncensoredAnswer({ content, reasoning_content: reasoning })
    if (!sawSse || answerSoFar.length < 20) throw e
    cutEarly = true
  }
  if (!sawSse) {
    try { return JSON.parse(rawAll) } catch (_) { return {} }
  }
  const finalAnswer = extractUncensoredAnswer({ content, reasoning_content: reasoning })
  const finalContent = cutEarly ? trimIncompleteSentence(finalAnswer || content) : content
  return {
    choices: [{ message: { role: 'assistant', content: finalContent, ...(reasoning ? { reasoning_content: reasoning } : {}) } }],
    ...(usage ? { usage } : {})
  }
}

const UNCENSORED_LOAD_POLL_MS = 3000

async function ensureUncensoredModelLoaded (endpoint, model, headers, { r18Mode = false, timeoutMs = 240 * 1000, onProgress = null } = {}) {
  if (!endpoint || endpoint.gateway || !isLocalUncensoredUrl(endpoint.url) || !/\/chat\/completions$/.test(endpoint.url)) {
    return model
  }
  const modelsUrl = endpoint.url.replace(/\/chat\/completions$/, '/models')
  const primaryLoadUrl = endpoint.url.replace(/\/v1\/chat\/completions$|\/chat\/completions$/, '/models/load')
  const fallbackLoadUrl = `${modelsUrl}/load`
  const findEntry = (list, target) => {
    if (!Array.isArray(list) || !list.length) return null
    const cleanTarget = String(target || '').trim().replace(/\.gguf$/i, '').toLowerCase()
    const exact = list.find(m => typeof m?.id === 'string' && m.id.replace(/\.gguf$/i, '').toLowerCase() === cleanTarget)
    if (exact) return exact
    const partial = cleanTarget ? list.find(m => typeof m?.id === 'string' && m.id.toLowerCase().includes(cleanTarget)) : null
    if (partial) return partial
    if (r18Mode && list.length > 1) {
      return list.find(m => typeof m?.id === 'string' && /deckard|r-?18|uncensored-thinking/i.test(m.id)) || list[1]
    }
    return typeof list[0]?.id === 'string' ? list[0] : null
  }
  const deadline = Date.now() + Math.min(timeoutMs, 300 * 1000)
  let resolvedModel = model
  let loadRequested = false
  let unloadedPollsSinceLoad = 0
  let notified = false
  while (Date.now() < deadline) {
    let list = null
    try {
      const probeTimeout = Math.min(30 * 1000, Math.max(5000, deadline - Date.now()))
      const res = await fetch(modelsUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(probeTimeout),
        dispatcher: dispatcherFor(probeTimeout)
      })
      if (!res || !res.ok) return resolvedModel
      const data = await res.json()
      list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : null)
    } catch (_) {
      return resolvedModel
    }
    if (list) updateDetectedModelsFromList(list)
    const entry = findEntry(list, resolvedModel)
    if (!entry) return resolvedModel
    if (typeof entry.id === 'string' && entry.id.trim()) resolvedModel = entry.id.trim()
    const state = entry.status?.value
    if (!state || state === 'loaded') return resolvedModel
    if (state !== 'unloaded' && state !== 'loading') return resolvedModel
    if (!notified && typeof onProgress === 'function') {
      notified = true
      await Promise.resolve(onProgress('無検閲モデルを GPU にロードしています…（初回やモデル切替時は 1〜2 分ほどかかります）')).catch(() => {})
    }
    if (state === 'unloaded' && (!loadRequested || unloadedPollsSinceLoad >= 3)) {
      loadRequested = true
      unloadedPollsSinceLoad = 0
      const loadTimeout = Math.min(240 * 1000, Math.max(30 * 1000, deadline - Date.now()))
      const res = await fetch(primaryLoadUrl, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(loadTimeout),
        dispatcher: dispatcherFor(loadTimeout),
        body: JSON.stringify({ model: resolvedModel })
      }).catch(() => null)
      if (res && (res.status === 404 || res.status === 405) && fallbackLoadUrl !== primaryLoadUrl) {
        await res.text?.().catch(() => {})
        await fetch(fallbackLoadUrl, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(loadTimeout),
          dispatcher: dispatcherFor(loadTimeout),
          body: JSON.stringify({ model: resolvedModel })
        }).then(r => r?.text?.().catch(() => {})).catch(() => {})
      } else {
        await res?.text?.().catch(() => {})
      }
    } else if (state === 'unloaded') {
      unloadedPollsSinceLoad++
    }
    await retryTimer.sleep(UNCENSORED_LOAD_POLL_MS)
  }
  return resolvedModel
}

async function describeImagesForUncensored (attachedPictures) {
  if (!Array.isArray(attachedPictures) || !attachedPictures.length || !isConfigured()) return null
  try {
    const parts = [
      { text: prompts.render('chat/uncensored/describe-images') },
      ...attachedPictures.flatMap(p => [
        { text: p.name || '添付画像' },
        { inlineData: { mimeType: p.mimeType, data: p.buffer.toString('base64') } }
      ])
    ]
    const res = await callGemini(
      lightModel(),
      {
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.2 }
      },
      { purpose: 'image-describe', timeoutMs: 30 * 1000, strictSafety: false }
    )
    const text = (res?.parts || [])
      .filter(p => typeof p.text === 'string' && !p.thought)
      .map(p => p.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim()
    return text || null
  } catch (e) {
    global.logger?.warn(`[UNCENSORED]: Could not describe attached image(s) for uncensored model: ${e.message?.slice(0, 200)}`)
    return null
  }
}

async function callUncensored (contents, declarations, allowed = null, { timeoutMs = Math.max(replyTimeoutMs(), 420 * 1000) } = {}) {
  const endpoint = uncensoredEndpoint()
  if (!endpoint) throw new GeminiError('Uncensored endpoint is not configured', 'AI の呼び出しに失敗しました')
  let model = uncensoredModel(contents)
  const modelOverride = Boolean(contents?.explicitUncensoredModel)
  const headers = uncensoredHeaders(endpoint)
  const local = !endpoint.gateway && isLocalUncensoredUrl(endpoint.url)
  const canSubmitChat = (!allowed || allowed.includes(SUBMIT_CHAT_DECLARATION.name)) && declarations.some(d => d.name === SUBMIT_CHAT_DECLARATION.name)
  const isMultiTurnOrEdit = Boolean(contents?.isEdit || contents?.isRevision) || (Array.isArray(contents) && contents.length > 1)
  const useCompact = local && canSubmitChat && !isMultiTurnOrEdit
  if (contents && !contents.imageDescription && Array.isArray(contents.attachedPictures) && contents.attachedPictures.length) {
    const desc = await describeImagesForUncensored(contents.attachedPictures)
    if (desc) contents.imageDescription = desc
  }
  const r18Mode = !!contents?.uncensoredR18Mode || isR18Text(model) || /deckard|r-?18|uncensored-thinking/i.test(model)
  const firstUserText = String(contents?.[0]?.parts?.[0]?.text || '')
  const story = isStoryRequest(firstUserText, asksForStory(contents))
  const styleLines = (!story && contents?.streamerPersona !== false)
    ? await require('./streamerStyle').sectionForPrompt({ slim: true, query: askedIn(firstUserText) }).catch(() => [])
    : []
  const style = styleLines.length ? styleLines.join('\n') : ''
  const alreadyHasStyleInUser = !useCompact && firstUserText.includes('### 配信者本人の話し方')
  const messages = toOpenAIMessages(uncensoredSystemInstruction({
    compact: useCompact,
    r18Mode,
    story,
    settings: serverSettings(contents),
    style: alreadyHasStyleInUser ? '' : style,
    streamerPersona: contents?.streamerPersona !== false,
    model
  }), contents, { compact: useCompact, r18Mode })
  const replyCacheKey = useCompact ? `uncensored-reply:${hashOf(JSON.stringify({ model, messages }))}` : null
  if (replyCacheKey) {
    const cachedReply = await aiCache.getJson(replyCacheKey)
    if (Array.isArray(cachedReply?.parts) && cachedReply.parts.length) {
      uncensoredState.usable = true
      uncensoredState.url = endpoint.url
      return { role: 'model', parts: cachedReply.parts }
    }
  }
  if (local) {
    model = await ensureUncensoredModelLoaded(endpoint, model, headers, {
      r18Mode: !!contents?.uncensoredR18Mode && !contents?.explicitUncensoredModel,
      timeoutMs,
      onProgress: contents?.onProgress
    })
  }
  const body = {
    model,
    messages,
    temperature: useCompact ? 0.8 : temperature(),
    ...(useCompact
      ? UNCENSORED_SAMPLING_PARAMS
      : {
          tools: toOpenAITools(declarations, allowed),
          tool_choice: allowed && allowed.length === 1
            ? { type: 'function', function: { name: allowed[0] } }
            : 'required'
        })
  }
  const markUnusable = () => {
    if (!modelOverride) {
      uncensoredState.url = endpoint.url
      uncensoredState.usable = false
      uncensoredState.checkedAt = Date.now()
    }
  }
  const usage = currentUsage()
  // Each request is recorded for the mention log as it was sent (aiTranscript.js), with how many
  // times it was sent.
  const sent = { body, attempts: 0 }
  const record = result => aiTranscript.recordUncensored({ model, body: sent.body, attempts: sent.attempts, ...result })
  const send = async payload => {
    sent.body = payload
    sent.attempts = 0
    let r
    for (let attempt = 0; ; attempt++) {
      if (usage) usage.requests++
      sent.attempts = attempt + 1
      r = await fetch(endpoint.url, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: dispatcherFor(timeoutMs),
        body: JSON.stringify(payload)
      })
      const retryableStatus = r.status === 429 || r.status === 503 || (local && (r.status === 500 || r.status === 502 || r.status === 504))
      if (!retryableStatus || attempt === MAX_RETRIES) return r
      const wait = retryDelayMs(r.headers?.get?.('retry-after'), attempt)
      await r.text().catch(() => {})
      if (usage) {
        usage.retries++
        await usage.onWait(wait)
      }
      await retryTimer.sleep(wait)
      if (local && r.status !== 429) {
        model = await ensureUncensoredModelLoaded(endpoint, model, headers, {
          r18Mode: !!contents?.uncensoredR18Mode && !contents?.explicitUncensoredModel,
          timeoutMs,
          onProgress: contents?.onProgress
        })
        payload = { ...payload, model }
      }
    }
  }
  const buildMinimalBody = () => {
    const compactMsgs = toOpenAIMessages(uncensoredSystemInstruction({ compact: true, r18Mode, story, settings: serverSettings(contents), style, streamerPersona: contents?.streamerPersona !== false, model }), contents, { compact: true, r18Mode })
      .map(m => m.role === 'user' && typeof m.content === 'string' && m.content.length > 2800
        ? { ...m, content: `${m.content.slice(0, 500)}\n\n${m.content.slice(-2300)}` }
        : m)
    return {
      model,
      messages: compactMsgs,
      temperature: 0.8,
      ...UNCENSORED_SAMPLING_PARAMS
    }
  }
  let res
  try {
    res = await send(body)
    if (res.status === 400) {
      record({ error: `HTTP 400 ${(await res.text().catch(() => '')).slice(0, 1000)}; asked again with a shorter request` })
      res = await send(buildMinimalBody())
    }
  } catch (err) {
    markUnusable()
    record({ error: err })
    throw err
  }
  if (!res.ok) {
    if (res.status >= 500) markUnusable()
    const text = (await res.text()).slice(0, 1000)
    record({ error: `HTTP ${res.status} ${text}` })
    throw new GeminiError(`Uncensored request failed: HTTP ${res.status} ${text}`, `AI の呼び出しに失敗しました（HTTP ${res.status}）`, null, res.status)
  }
  let data
  try {
    data = await readUncensoredResponse(res)
  } catch (err) {
    markUnusable()
    record({ error: err })
    throw err
  }
  record({ response: data })
  let parts = parseUncensoredParts(data?.choices?.[0]?.message, declarations, allowed)
  if (!parts.length && useCompact) {
    let retryRes
    try {
      retryRes = await send(buildMinimalBody())
    } catch (err) {
      markUnusable()
      record({ error: err })
      throw err
    }
    if (retryRes.ok) {
      try {
        data = await readUncensoredResponse(retryRes)
      } catch (err) {
        markUnusable()
        record({ error: err })
        throw err
      }
      record({ response: data })
      parts = parseUncensoredParts(data?.choices?.[0]?.message, declarations, allowed)
    } else {
      if (retryRes.status >= 500) markUnusable()
      record({ error: `HTTP ${retryRes.status} ${(await retryRes.text().catch(() => '')).slice(0, 1000)}` })
    }
  }
  const msg = data?.choices?.[0]?.message
  const rawPromptChars = messages.reduce((sum, m) => {
    const c = m?.content
    if (typeof c === 'string') return sum + c.length
    if (Array.isArray(c)) return sum + c.reduce((n, p) => n + (typeof p?.text === 'string' ? p.text.length : 0), 0)
    return sum
  }, 0)
  const rawAnswerChars = typeof msg?.content === 'string' ? msg.content.length : 0
  const rawReasoningChars = typeof msg?.reasoning_content === 'string' ? msg.reasoning_content.length : 0
  const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens || 0
  const estimatedThoughts = rawReasoningChars ? Math.ceil(rawReasoningChars / 3) : 0
  const usageMeta = data?.usage
    ? {
        promptTokenCount: data.usage.prompt_tokens || 0,
        cachedContentTokenCount: data.usage.prompt_tokens_details?.cached_tokens || 0,
        candidatesTokenCount: data.usage.completion_tokens != null
          ? Math.max(0, (data.usage.completion_tokens || 0) - reasoningTokens)
          : (rawAnswerChars ? Math.ceil(rawAnswerChars / 3) : 0),
        thoughtsTokenCount: data.usage.completion_tokens != null
          ? reasoningTokens
          : (reasoningTokens || estimatedThoughts)
      }
    : (rawAnswerChars + rawReasoningChars > 0
        ? {
            promptTokenCount: Math.max(1, Math.round(rawPromptChars / 3)),
            cachedContentTokenCount: 0,
            candidatesTokenCount: rawAnswerChars > 0 ? Math.max(1, Math.round(rawAnswerChars / 3)) : 0,
            thoughtsTokenCount: estimatedThoughts
          }
        : undefined)
  recordTokens('mention-uncensored', model, usageMeta)
  addTokens(usageMeta, { model, flex: false })
  geminiLoad.record(require('../utils/mentionQuota').costOf(usageMeta, model, { flex: false }))
  addModel(model, { flex: false })
  if (!parts.length) {
    throw new GeminiError(`Uncensored model returned no content: ${JSON.stringify(data).slice(0, 1000)}`, 'AI から応答がありませんでした')
  }
  uncensoredState.usable = true
  uncensoredState.url = endpoint.url
  if (replyCacheKey) {
    uncensoredCacheKeys.add(replyCacheKey)
    await aiCache.setJson(replyCacheKey, { parts }, UNCENSORED_REPLY_CACHE_TTL_SECONDS)
  }
  return { role: 'model', parts }
}

const HIGH_THINKING_PATTERN = /https?:\/\/|イベント|フォーラム|告知|募集|登録|投稿|まとめ|比較|計算|推理|分析|解説|詳しく|なぜ|理由|手順|コード|プログラム|設計|企画|スケジュール|カレンダー|\d+\s*(?:月|日|時|分|時間)|明日|明後日|来週|今週末|毎週|定例/i
const QUESTION_OR_LOOKUP_PATTERN = /[?？]|何|なに|なんの|いつ|どこ|誰|だれ|どう|なぜ|なんで|どれ|いくら|教え|調べ|探し|おすすめ|オススメ|名作|神回|語ろ|好き|感想|評価|ルール|チャンネル|動画|配信|ゲーム|マイクラ|wiki|再生|日付|公開|投稿|登録者|高評価|コメント|時間|長さ|古い|最新|最初|ランキング|人気/i

// Chooses how much Gemini 3 thinks for a mention when neither the server (%replymodel) nor
// GEMINI_THINKING_LEVEL fixed a level: greetings and short reactions think at minimal, brief
// single-turn questions at low, multi-step or medium chats at medium, and event/forum drafts,
// edits, stories, URLs or reasoning-heavy requests at high.
function adaptiveThinkingLevel (contents) {
  if (contents?.isEdit || contents?.isRevision || contents?.hasForum) return 'high'
  let raw = ''
  if (typeof contents?.requestText === 'string') {
    raw = contents.requestText
  } else {
    const firstText = String(contents?.[0]?.parts?.[0]?.text || '')
    const m = firstText.match(/<untrusted source="request">\n([\s\S]*?)\n<\/untrusted>/)
    raw = m ? m[1] : firstText
  }
  if (!raw.trim()) return 'high'
  // sokudan's reading of the request comes first; the patterns and lengths below are for when it
  // gave none.
  const decision = contents?.sokudanDecision
  if (decision) {
    if (decision.isStory || decision.needsDeep) return 'high'
    if (THINKING_LEVELS.includes(decision.thinkingLevel)) return decision.thinkingLevel
  }
  if (HIGH_THINKING_PATTERN.test(raw) || STORY_REQUEST_PATTERN.test(raw)) return 'high'
  const stripped = raw
    .replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+|:\w+:/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
  const len = [...stripped].length
  if (len > 160) return 'high'
  const firstStep = !Array.isArray(contents) || contents.length <= 1
  if (len <= 12 && firstStep && !contents?.hasReference && !contents?.hasPictures && !QUESTION_OR_LOOKUP_PATTERN.test(raw)) {
    return 'minimal'
  }
  if (len <= 60 && firstStep && !contents?.hasPictures) return 'low'
  return 'medium'
}

const UNTRUSTED_WRAP_RE = /^<untrusted source="([^"]+)">\n([\s\S]*)\n<\/untrusted>$/
const TOOL_MASK_THRESHOLD = 1200
const TOOL_MASK_KEEP_CHARS = 500
const TOOL_MASK_MAX_URLS = 5

function unwrapUntrusted (text) {
  const m = String(text || '').match(UNTRUSTED_WRAP_RE)
  return m ? { source: m[1], inner: m[2] } : { source: null, inner: String(text || '') }
}

// Masks bulky functionResponse payloads from earlier tool steps before sending `contents` over the
// wire, while leaving the most recent tool-response turn intact and never mutating `contents`
// itself (so safeLinks still sees every URL in conversation.contents).
function compactContentsForWire (contents) {
  if (process.env.TOOL_OBSERVATION_MASK === 'false' || !Array.isArray(contents) || contents.length < 4) return contents
  const toolTurnIndices = []
  for (let i = 0; i < contents.length; i++) {
    const turn = contents[i]
    if (turn?.role === 'user' && Array.isArray(turn.parts) && turn.parts.some(p => p.functionResponse)) {
      toolTurnIndices.push(i)
    }
  }
  if (toolTurnIndices.length <= 1) return contents
  const maskSet = new Set(toolTurnIndices.slice(0, -1))
  let changed = false
  const next = contents.map((turn, idx) => {
    if (!maskSet.has(idx)) return turn
    let turnChanged = false
    const parts = turn.parts.map(part => {
      const raw = part.functionResponse?.response?.result
      if (typeof raw !== 'string' || raw.length <= TOOL_MASK_THRESHOLD) return part
      const { source, inner } = unwrapUntrusted(raw)
      if (inner.length <= TOOL_MASK_THRESHOLD) return part
      const head = inner.slice(0, TOOL_MASK_KEEP_CHARS)
      const headUrls = urlsIn(head)
      const extraUrls = [...urlsIn(inner.slice(TOOL_MASK_KEEP_CHARS))].filter(u => !headUrls.has(u)).slice(0, TOOL_MASK_MAX_URLS)
      const urlLine = extraUrls.length ? `\n参照URL: ${extraUrls.join(' ')}` : ''
      const omitted = Math.max(0, inner.length - head.length)
      const maskedInner = `${head}${urlLine}\n…（前ステップで確認済み・残り ${omitted} 文字省略）`
      const masked = source ? wrap(source, maskedInner) : maskedInner
      turnChanged = true
      changed = true
      return {
        ...part,
        functionResponse: {
          ...part.functionResponse,
          response: { ...part.functionResponse.response, result: masked }
        }
      }
    })
    return turnChanged ? { ...turn, parts } : turn
  })
  return changed ? next : contents
}

async function generate (contents, declarations, allowed = null, { deep = false, uncensored = false } = {}) {
  if (uncensored) return callUncensored(contents, declarations, allowed)
  const model = deep ? deepModel() : replyModel(contents)
  const strictSafety = !!contents.safetyFilter
  const prefix = {
    systemInstruction: { parts: [{ text: systemInstruction({ safetyFilter: !!contents.safetyFilter, omitMature: !!contents.omitMature, settings: serverSettings(contents), streamerPersona: contents?.streamerPersona !== false }) }] },
    tools: [{ functionDeclarations: declarations }],
    // ANY: every turn must be a tool call, so the loop always ends in a submit_* call.
    toolConfig: { functionCallingConfig: { mode: 'ANY', ...(allowed ? { allowedFunctionNames: allowed } : {}) } }
  }
  const generationConfig = {
    ...(isGemini4(model) ? {} : { temperature: temperature() }),
    ...thinkingConfig(model, deep ? { setting: 'GEMINI_DEEP_THINKING_LEVEL', fallback: 'high' } : undefined)
  }
  // The server's own thinking level (%replymodel), for the usual model only; otherwise scale
  // thinking effort with request complexity unless GEMINI_THINKING_LEVEL was set explicitly.
  if (!deep && generationConfig.thinkingConfig) {
    if (contents.thinking) {
      generationConfig.thinkingConfig = { thinkingLevel: normalizeThinkingLevel(model, contents.thinking) }
    } else if (!process.env.GEMINI_THINKING_LEVEL && process.env.GEMINI_ADAPTIVE_THINKING !== 'false') {
      generationConfig.thinkingConfig = { ...generationConfig.thinkingConfig, thinkingLevel: normalizeThinkingLevel(model, adaptiveThinkingLevel(contents)) }
    }
  }
  // The busier the bot as a whole, the less a reply thinks (geminiLoad.js).
  if (generationConfig.thinkingConfig) {
    generationConfig.thinkingConfig = {
      ...generationConfig.thinkingConfig,
      thinkingLevel: normalizeThinkingLevel(model, geminiLoad.cappedThinking(generationConfig.thinkingConfig.thinkingLevel))
    }
  }
  const wireContents = compactContentsForWire(contents)
  const callOptions = deep
    ? { purpose: 'mention-deep', timeoutMs: DEEP_TIMEOUT_MS, flex: process.env.GEMINI_DEEP_FLEX !== 'false', stream: true, strictSafety }
    : { purpose: 'mention', timeoutMs: replyTimeoutMs(), flex: contents.tier === 'flex', stream: true, strictSafety }
  // The last step, limited to submitting (allowed), has its own toolConfig: sent in full, since a
  // request that uses a cache cannot set one.
  callOptions.transcript = { system: prefix.systemInstruction.parts[0].text, tools: prefix.tools }
  const cache = allowed ? null : await cachedPrefix(model, prefix)
  if (cache) {
    try {
      return await callGemini(model, { cachedContent: cache, contents: wireContents, generationConfig }, callOptions)
    } catch (e) {
      if (!/cachedContent|CachedContent|cached content/i.test(e.message) || e.blocked) throw e
      forgetCache(cache) // gone on Gemini's side: once more in full
    }
  }
  return callGemini(model, { ...prefix, contents: wireContents, generationConfig }, callOptions)
}

// Runs the model with the read-only tools until it submits a draft, appending every turn to
// `contents` so the conversation can be continued with a correction. Returns the submit call.
// contents.deep: the conversation went over to the stronger model (think_deeper), so a correction
// continues with it.
// HTTP statuses of a Flex request that found no capacity or was not waited for.
const FLEX_UNAVAILABLE = [429, 503, 524]

function stripModelTurnThoughts (turn) {
  if (!turn || turn.role !== 'model' || !Array.isArray(turn.parts)) return turn
  const hasThoughtOrSig = turn.parts.some(p => p?.thought || (p && typeof p === 'object' && ('thoughtSignature' in p || 'thought_signature' in p)))
  if (!hasThoughtOrSig) return turn
  const parts = turn.parts
    .filter(p => !p?.thought)
    .map(p => {
      if (!p || typeof p !== 'object' || (!('thoughtSignature' in p) && !('thought_signature' in p))) return p
      const copy = { ...p }
      delete copy.thoughtSignature
      delete copy.thought_signature
      return copy
    })
  return { ...turn, parts }
}

function cloneContentsWithoutThoughts (contents) {
  const stripped = contents.map(stripModelTurnThoughts)
  for (const key of Object.keys(contents)) {
    if (!/^(?:0|[1-9]\d*)$/.test(key)) {
      stripped[key] = contents[key]
    }
  }
  return stripped
}

// What the bot gathered around a request, written by other people: the server's information
// (knowledge, the server's running jokes and how it talks), the channels and members it names,
// what was just said in the channel, and the conversation it replies to. Google can block a whole
// request for something in these, however harmless the request itself.
const GATHERED_SECTION = /(?:^|\n)## [^\n]*\n<untrusted source="(server|channels|members|recent|conversation)">[\s\S]*?<\/untrusted>/g

// The first turn of a conversation without what was gathered around the request (GATHERED_SECTION)
// and without the pictures shown with it; null when it has none of them. `dropped`: which.
function withRequestAlone (turn) {
  const text = turn?.parts?.[0]?.text
  if (turn?.role !== 'user' || typeof text !== 'string') return null
  const dropped = [...text.matchAll(GATHERED_SECTION)].map(m => m[1])
  const pictures = turn.parts.length > 1
  if (!dropped.length && !pictures) return null
  if (pictures) dropped.push('pictures')
  return { turn: { role: 'user', parts: [{ text: text.replace(GATHERED_SECTION, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '') }] }, dropped }
}

// Puts every tool result after `start` away (WITHHELD_NOTE in its place). Resolves to how many.
function withholdToolResults (contents, start) {
  let count = 0
  for (let i = start; i < contents.length; i++) {
    const turn = contents[i]
    if (turn?.role !== 'user' || !turn.parts?.some(p => p.functionResponse)) continue
    contents[i] = {
      ...turn,
      parts: turn.parts.map(p => {
        if (!p.functionResponse) return p
        count++
        return { functionResponse: { ...p.functionResponse, response: { result: WITHHELD_NOTE } } }
      })
    }
  }
  return count
}

async function runAgent (contents, tools, submits = SUBMIT_DECLARATIONS) {
  const allowUncensored = contents.uncensoredR18 !== false && !contents.safetyFilter
  // Not offered again once the stronger model or the uncensored fallback took over this conversation,
  // and never offered alongside minor terms or after a safety-block retry strips mature policy.
  const offered = [
    ...(deepModel() && !contents.deepRefused && !contents.uncensored && !contents.uncensoredFailed ? [THINK_DEEPER_DECLARATION] : []),
    ...(allowUncensored && !contents.isEdit && !contents.minorTerm && !contents.omitMature && !contents.disallowUncensoredHandover && isUncensoredConfigured() && !contents.uncensored && !contents.uncensoredFailed ? [HAND_OVER_R18_DECLARATION] : [])
  ]
  const stripMature = () => {
    contents.omitMature = true
    const idx = offered.indexOf(HAND_OVER_R18_DECLARATION)
    if (idx !== -1) offered.splice(idx, 1)
  }
  const declarationsFor = () => [
    ...tools.declarations,
    ...offered.filter(d => !(contents.deep && d === THINK_DEEPER_DECLARATION) && !contents.uncensored),
    ...submits
  ]
  const start = contents.length
  // Set when tool results got this turn refused (below); a correction may use tools again.
  contents.toolsWithheld = false
  contents.submitOnly = false
  const steps = maxSteps()
  for (let step = 0; step < steps; step++) {
    const last = step === steps - 1
    // The last step answers with what is known instead of failing: only a submit can be called.
    if (last && step > 0) contents[contents.length - 1].parts.push({ text: LAST_STEP_NOTE })
    let content
    try {
      content = await generate(contents, declarationsFor(), last || contents.submitOnly ? submits.map(d => d.name) : null, { deep: !!contents.deep, uncensored: !!contents.uncensored })
    } catch (e) {
      if (contents.uncensored && !contents.geminiBlocked) {
        const currentModel = uncensoredModel(contents)
        const baseModel = uncensoredBaseModel()
        const canFallbackToBase = !contents.triedUncensoredBase &&
          baseModel !== currentModel &&
          ((contents.uncensoredR18Mode && !contents.explicitUncensoredModel) ||
            contents.inheritedUncensoredModel ||
            currentModel.toLowerCase() === uncensoredR18Model().toLowerCase())
        if (canFallbackToBase) {
          global.logger?.warn(`[UNCENSORED]: ${currentModel} failed (${e.message.slice(0, 200)}); trying ${baseModel}`)
          addFallback(`${currentModel} unavailable → ${baseModel}`)
          contents.splice(start)
          contents.uncensoredR18Mode = false
          contents.explicitUncensoredModel = null
          contents.inheritedUncensoredModel = false
          contents.triedUncensoredBase = true
          step = -1
          continue
        }
        const fallback = replyModel(contents)
        global.logger?.warn(`[UNCENSORED]: ${currentModel} failed (${e.message.slice(0, 200)}); ${fallback} answers instead`)
        addFallback(`${currentModel} unavailable → ${fallback}`)
        contents.splice(start)
        for (let i = 0; i < contents.length; i++) contents[i] = stripModelTurnThoughts(contents[i])
        contents.uncensored = false
        contents.uncensoredFailed = true
        contents.deepRefused = true
        contents.uncensoredError = e
        offered.length = 0
        step = -1
        continue
      }
      // Blocked by Google after tools were used: what they read (other members' messages, the
      // wiki, the channel) is most often what it is about, and asking again from the start would
      // only read it all again. So the same step is asked once more with every tool result of this
      // turn put away, and only a submit allowed: the answer is made from the request and what the
      // model already knows. Not for the uncensored model, which Google does not judge, nor for a
      // request that may be one for adult writing (the uncensored model answers instead, below).
      const withheld = e.blocked && !contents.uncensored && contents.r18Maybe !== true && !contents.toolsWithheld ? withholdToolResults(contents, start) : 0
      if (withheld) {
        const failed = contents.deep ? deepModel() : replyModel(contents)
        global.logger?.warn(`[GEMINI]: ${failed} refused (${e.blocked}) after ${withheld} tool result(s); asking again without them`)
        addFallback(`${failed} refused (${e.blocked}) → without ${withheld} tool result(s)`)
        stripMature()
        contents.toolsWithheld = true
        contents.submitOnly = true
        step--
        continue
      }
      // Blocked by Google: once more with the request alone, without what was gathered around it
      // (other people's messages, the server's knowledge, pictures), which a block is most often
      // about. Only once, and only for the first request (not a correction of a draft).
      // Not for the stronger model (Flash answers instead, below), nor for a request that may itself
      // be one for adult writing (the uncensored model answers instead, below).
      const alone = e.blocked && !contents.uncensored && !contents.deep && contents.r18Maybe !== true && !contents.requestAlone && start === 1 && !contents.isRevision ? withRequestAlone(contents[0]) : null
      if (alone) {
        const failed = contents.deep ? deepModel() : replyModel(contents)
        global.logger?.warn(`[GEMINI]: ${failed} refused (${e.blocked}) with ${alone.dropped.join(', ')} in the request; asking again with the request alone`)
        addFallback(`${failed} refused (${e.blocked}) → without ${alone.dropped.join(', ')}`)
        contents.splice(start)
        contents[0] = alone.turn
        stripMature()
        contents.requestAlone = true
        step = -1
        continue
      }
      // Only a request that may be one for adult writing: a block for something else (copyright,
      // personal data, dangerous content) is not answered by the uncensored model instead.
      if (allowUncensored && !contents.disallowUncensoredHandover && !contents.uncensored && e.blocked && R18_BLOCKS.includes(e.blocked) && contents.r18Maybe !== false && isUncensoredConfigured() && !contents.uncensoredFailed) {
        const failed = contents.deep ? deepModel() : replyModel(contents)
        const notes = extractLookupNotes(contents.slice(start))
        if (notes) contents.lookupNotes = notes
        contents.splice(start)
        contents.deep = false
        contents.uncensored = true
        contents.uncensoredR18Mode = false
        contents.geminiBlocked = true
        const fallback = uncensoredModel(contents)
        global.logger?.info(`[GEMINI]: ${failed} refused (${e.blocked}); ${fallback} answers instead`)
        addFallback(`${failed} refused (${e.blocked}) → ${fallback}`)
        offered.length = 0
        step = -1
        continue
      }
      if (e.blocked && contents.uncensoredError) throw contents.uncensoredError
      const unavailable = FLEX_UNAVAILABLE.includes(e.status)
      if (contents.deep && (e.blocked || unavailable)) {
        // The stronger model refused (its safety filters or policy), or had no Flex capacity: the
        // usual model answers instead, from the request again, and the line under the reply says so.
        const fallback = replyModel(contents)
        const why = e.blocked ? `refused (${e.blocked})` : `Flex unavailable (HTTP ${e.status})`
        global.logger?.info(`[GEMINI]: ${deepModel()} ${why}; ${fallback} answers instead`)
        addFallback(`${deepModel()} ${why} → ${fallback}`)
        contents.splice(start)
        for (let i = 0; i < contents.length; i++) contents[i] = stripModelTurnThoughts(contents[i])
        if (e.blocked) stripMature()
        contents.deep = false
        contents.deepRefused = true
        offered.length = 0
        step = -1
        continue
      }
      throw e
    }
    const r18HandOver = allowUncensored && !contents.disallowUncensoredHandover && !contents.uncensored && isUncensoredConfigured() && !contents.uncensoredFailed && content.parts.some(p => p.functionCall?.name === HAND_OVER_R18_DECLARATION.name)
    if (r18HandOver) {
      const fromModel = contents.deep ? deepModel() : replyModel(contents)
      const handOverCall = content.parts.find(p => p.functionCall?.name === HAND_OVER_R18_DECLARATION.name)?.functionCall
      if (typeof handOverCall?.args?.image_description === 'string' && handOverCall.args.image_description.trim()) {
        contents.imageDescription = handOverCall.args.image_description.trim()
      }
      const notes = extractLookupNotes(contents.slice(start))
      if (notes) contents.lookupNotes = notes
      contents.splice(start)
      contents.deep = false
      contents.uncensored = true
      contents.uncensoredR18Mode = true
      const fallback = uncensoredModel(contents)
      global.logger?.info(`[GEMINI]: ${fromModel} R18 handover; ${fallback} answers instead`)
      addFallback(`${fromModel} R18 handover → ${fallback}`)
      offered.length = 0
      step = -1
      continue
    }
    const handOver = !contents.deep && !contents.uncensored && offered.length && content.parts.some(p => p.functionCall?.name === THINK_DEEPER_DECLARATION.name)
    if (handOver) {
      // The stronger model starts this turn again from the request: one model's thought
      // signatures are not another's, so nothing of this model's turn goes with it.
      contents.splice(start)
      for (let i = 0; i < contents.length; i++) contents[i] = stripModelTurnThoughts(contents[i])
      contents.deep = true
      global.logger?.info(`[GEMINI]: Handing a request over to ${deepModel()}`)
      await tools.progress?.(DEEP_PROGRESS)
      step = -1
      continue
    }
    // Echo the model turn back unchanged: newer models attach thought signatures to it.
    contents.push(content)
    const calls = content.parts.filter(p => p.functionCall).map(p => p.functionCall)
    const submitted = calls.find(c => submits.some(d => d.name === c.name))
    // A refusal is handed over when it was over sexual content, or, for another refusal, when the
    // request is known to be one for adult writing: one turned down as dangerous or hateful stays so.
    const storyCandidate = asksForStory(contents) === true || (asksForStory(contents) !== false && STORY_OR_SCENE_REQUEST_PATTERN.test(String(contents.requestText || '')))
    const checkSokudanRefusal = contents.r18Maybe === true || storyCandidate
    const refusal = submitted && allowUncensored && !contents.disallowUncensoredHandover && !contents.uncensored && isUncensoredConfigured() && !contents.uncensoredFailed && submitted.name === SUBMIT_CHAT_DECLARATION.name
      ? await refusalKind(submitted.args?.text, { checkSokudan: checkSokudanRefusal, requestText: contents.requestText || '' })
      : null
    if (refusal === 'sexual' || (refusal === 'other' && contents.r18Maybe === true)) {
      const fromModel = contents.deep ? deepModel() : replyModel(contents)
      const notes = extractLookupNotes(contents.slice(start))
      if (notes) contents.lookupNotes = notes
      contents.splice(start)
      contents.deep = false
      contents.uncensored = true
      contents.uncensoredR18Mode = true
      const fallback = uncensoredModel(contents)
      global.logger?.info(`[GEMINI]: ${fromModel} refused in reply (R18); ${fallback} answers instead`)
      addFallback(`${fromModel} refused (R18) → ${fallback}`)
      offered.length = 0
      step = -1
      continue
    }
    // `calls` is kept: a correction must answer every call of this turn, not just the submit.
    if (submitted) return { name: submitted.name, args: submitted.args || {}, calls }
    if (calls.length === 0) throw new GeminiError(`Gemini answered without a tool call: ${JSON.stringify(content).slice(0, 1000)}`, 'AI の応答の形式が想定と違いました')
    // Several lookups of one step at the same time, not one after another; but one after another
    // when the requester is asked something (two ask_user calls would fight over the same message).
    const asks = calls.some(c => c.name === 'ask_user')
    const responses = []
    if (asks) {
      for (const c of calls) responses.push({ functionResponse: { name: c.name, response: await tools.call(c.name, c.args) } })
    } else {
      responses.push(...await Promise.all(calls.map(async c => ({ functionResponse: { name: c.name, response: await tools.call(c.name, c.args) } }))))
    }
    contents.push({ role: 'user', parts: responses })
  }
  return { name: null, args: { found: false, reason: '調べる手順が多すぎたため、下書きを作れませんでした。依頼をもう少し具体的にしてください。' } }
}

// Turns the model's answer into a Discord scheduled event body, or a reason it can't be one. The
// model is not trusted to get Discord's constraints right, so every field is checked here.
// keepStart: the start time of an event being edited, which may already have passed (a running
// event) and is fine as long as it is not changed.
function toScheduledEvent (draft, guild, now, { keepStart = null } = {}) {
  if (!draft.found) return { error: draft.reason || 'イベントの情報を読み取れませんでした。' }
  const name = (draft.name || '').trim().slice(0, 100)
  if (!name) return { error: 'イベント名を読み取れませんでした。' }
  const start = new Date(draft.start)
  if (isNaN(start)) return { error: '開始日時を読み取れませんでした。' }
  if (start <= now && start.getTime() !== keepStart?.getTime()) return { error: `開始日時（<t:${Math.floor(start / 1000)}:F>）が過去のため登録できません。` }

  let end = draft.end ? new Date(draft.end) : null
  let endGuessed = false
  if (!end || isNaN(end) || end <= start) {
    end = new Date(start.getTime() + DEFAULT_DURATION_MS)
    endGuessed = true
  }

  const event = {
    name,
    privacy_level: 2, // GUILD_ONLY, the only value Discord accepts
    scheduled_start_time: start.toISOString(),
    scheduled_end_time: end.toISOString(),
    description: withoutCharCount((draft.description || '').trim()).slice(0, 1000) || undefined
  }

  const channel = draft.channel_id && guild.channels.get(draft.channel_id)
  if ((draft.location_type === 'voice' || draft.location_type === 'stage') && channel && (channel.type === 2 || channel.type === 13)) {
    event.entity_type = channel.type === 13 ? ENTITY_TYPES.stage : ENTITY_TYPES.voice
    event.channel_id = channel.id
  } else {
    event.entity_type = ENTITY_TYPES.external
    event.entity_metadata = { location: (draft.location || '').trim().slice(0, 100) || '未定' }
  }
  return { event, endGuessed, imageUrls: imageUrlsOf(draft), imageInstruction: imageInstructionOf(draft) }
}

// Returns { kind: 'event', event, endGuessed }, { kind: 'forum', post, tagNames, truncated },
// { kind: 'message', message, truncated } for a message written into a channel,
// { kind: 'chat', text } for a reply to someone who was just talking, or { error } with a reason to
// show the requester.
// Every result carries `conversation`, which revise() continues.
async function check (conversation, { name, args, calls = [] }) {
  const { guild, member, now, forum, edit } = conversation
  conversation.lastCalls = calls
  conversation.lastGeminiModel = conversation.contents?.uncensored
    ? null
    : (conversation.contents?.deep ? deepModel() : replyModel(conversation.contents))
  if (name === SUBMIT_CHAT_DECLARATION.name) {
    const cleaned = stripDebugFooterLines(String(args.text || '')).trim().slice(0, MAX_CHAT_REPLY) || '……'
    return { kind: 'chat', text: cleaned, conversation }
  }
  if (name === SUBMIT_FORUM_DECLARATION.name) {
    // A forum named in the request wins over whatever the model picked.
    const result = await toForumPost(forum ? { ...args, channel_id: forum.id } : args, guild, member)
    return { ...(result.error ? result : { kind: 'forum', ...result }), conversation }
  }
  if (name === SUBMIT_CHANNEL_POST_DECLARATION.name) {
    // A message being changed stays in its channel.
    const result = toChannelPost(args, guild, member, { keepChannel: edit?.kind === 'message' ? edit.current.channel_id : null })
    return { ...(result.error ? result : { kind: 'message', ...result }), conversation }
  }
  if (name === null && !args.found) return { error: args.reason, conversation }
  const result = toScheduledEvent(args, guild, now, { keepStart: edit ? new Date(edit.current.start) : null })
  return { ...(result.error ? result : { kind: 'event', ...result }), conversation }
}

// forum: a forum channel named in the request ({ id, name }), images: URLs of attached images.
// pictures: images the model is shown with the request, [{ name, buffer, mimeType, combined, attachment }]
// (combined emojis, other servers' emojis, and attached/replied-to images, foreignEmojis.js).
// edit: something the bot made earlier that the request changes, as { kind, current } where
// current is its content in the submit tool's terms. Only that kind can be submitted, and a forum
// post stays in its forum.
// Required when used: eventTools requires this module.
const eventTools = () => require('./eventTools')

// model, thinking, tier: the server's own model, thinking level and tier (%replymodel); null for the default.

async function draft ({ request, referenced, recent = [], channelName, channelID, server, forum = null, images = [], pictures = [], edit = null, replyLength = null, streamerPersona = true, safetyFilter = false, uncensoredR18 = true, model = null, thinking = null, tier = null, decision, guild, member, tools, now = new Date() }) {
  const parsed = parseModelDirective(request)
  const attachedPics = pictures.filter(p => p.attachment)
  if (parsed.directive) {
    request = parsed.text || (!referenced && (images.length || attachedPics.length) ? '（添付された画像を見て返事や作成をしてください）' : '（返信先のメッセージに答えてください）')
  }
  const rawReferenced = referenced
  if (referenced && (typeof referenced.text === 'string' || typeof referenced.othersText === 'string')) {
    referenced = {
      ...referenced,
      ...(typeof referenced.text === 'string' ? { text: stripDebugFooterLines(referenced.text) } : {}),
      ...(typeof referenced.othersText === 'string' ? { othersText: stripDebugFooterLines(referenced.othersText) } : {})
    }
  }
  const emojiPics = pictures.filter(p => !p.attachment)
  const combined = emojiPics.filter(p => p.combined)
  const foreign = emojiPics.filter(p => !p.combined)
  const emojiShown = emojiPics.length
    ? [
        { text: prompts.render('chat/pictures/emoji', { combined: combined.length > 0, foreign: foreign.map(p => `:${p.name}:`).join(' ') }) },
        ...emojiPics.flatMap(p => [{ text: p.combined ? `連結絵文字 ${p.name}` : `:${p.name}:` }, { inlineData: { mimeType: p.mimeType, data: p.buffer.toString('base64') } }])
      ]
    : []
  const attachedShown = attachedPics.length
    ? [
        { text: prompts.render('chat/pictures/attached') },
        ...attachedPics.flatMap(p => [{ text: p.name || '添付画像' }, { inlineData: { mimeType: p.mimeType, data: p.buffer.toString('base64') } }])
      ]
    : []
  const shown = [...emojiShown, ...attachedShown]
  const conversation = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt({ request, referenced, recent, channelName, channelID, channelInfo: channelID ? eventTools().requestChannelInfo(channelID, guild) : null, server, forum, images, edit, channels: member ? eventTools().namedChannels([request, referenced?.text], guild, member) : [], people: member ? eventTools().namedMembers([request, referenced?.text], guild, member) : [], now }) }, ...shown] }],
    guild,
    member,
    tools,
    forum: edit?.kind === 'forum' ? { id: edit.current.channel_id } : forum,
    edit,
    submits: edit
      ? [SUBMIT_FOR_KIND[edit.kind], SUBMIT_CHAT_DECLARATION]
      : SUBMIT_DECLARATIONS,
    now
  }
  // What went with the request, for the mention log: why Google refused can be looked for there.
  const firstText = conversation.contents[0].parts[0].text
  setPrompt(firstText)
  const sources = [...firstText.matchAll(/<untrusted source="([^"]+)">/g)].map(m => m[1]).filter(name => name !== 'request')
  addContext(`sent: ${[...sources, ...(shown.length ? [`pictures ${emojiPics.length + attachedPics.length}`] : [])].join(', ') || 'request only'}`)
  // Kept with the conversation, so a correction (revise) uses them too.
  conversation.contents.model = model
  conversation.contents.thinking = THINKING_LEVELS.includes(thinking) ? thinking : null
  conversation.contents.tier = SERVICE_TIERS.includes(tier) ? tier : null
  conversation.contents.safetyFilter = !!safetyFilter
  // The server's settings, for the system instructions (serverSettings), kept for corrections too.
  conversation.contents.streamerPersona = streamerPersona !== false
  conversation.contents.replyLength = replyLength
  conversation.contents.uncensoredR18 = uncensoredR18 !== false && !safetyFilter
  conversation.contents.onProgress = tools?.progress || null
  conversation.contents.requestText = request
  conversation.contents.isEdit = !!edit
  conversation.contents.hasForum = !!forum
  conversation.contents.hasReference = !!referenced
  conversation.contents.hasPictures = attachedPics.length > 0 || images.length > 0
  if (attachedPics.length) conversation.contents.attachedPictures = attachedPics
  const minorTerm = mentionsMinor(request, referenced?.text)
  conversation.contents.minorTerm = minorTerm
  if (minorTerm) conversation.contents.omitMature = true
  // How Google Decisions API reads the request (what is asked for, a story, R18, how much thought),
  // asked once for every request; `decision` when the caller already asked (null: it gave no
  // answer). Kept with the conversation: the thinking level and how the uncensored model is written
  // to go by it.
  if (decision === undefined) {
    decision = sokudan.canDecide()
      ? await sokudan.classifyMentionRequest(request, referenced?.text, eventTools().channelTheme(channelID, guild, channelName))
      : null
  }
  if (decision) conversation.contents.sokudanDecision = decision
  const threadDirective = !parsed.directive ? resolveReferencedDirective(request, rawReferenced, decision) : null
  const r18 = r18Route({ request, referenced, decision })
  conversation.contents.r18Maybe = minorTerm ? false : r18.maybe
  conversation.contents.disallowUncensoredHandover = !!(minorTerm || r18.disallowHandover)
  if (parsed.directive && applyModelDirective(conversation.contents, parsed.directive)) {
    const chosen = conversation.contents.uncensored
      ? uncensoredModel(conversation.contents)
      : (conversation.contents.deep ? deepModel() : replyModel(conversation.contents))
    global.logger?.info(`[GEMINI]: Explicit model directive "${parsed.directive}" in request; using ${chosen}`)
  } else if (!minorTerm && conversation.contents.uncensoredR18 && isUncensoredConfigured() && r18.route) {
    conversation.contents.uncensored = true
    conversation.contents.directUncensored = true
    conversation.contents.uncensoredR18Mode = true
    const initial = replyModel(conversation.contents)
    const fallback = uncensoredModel(conversation.contents)
    global.logger?.info(`[GEMINI]: R18 request (${r18.why}); ${fallback} answers instead of ${initial}`)
  } else if (threadDirective && applyModelDirective(conversation.contents, threadDirective, { inherited: true })) {
    const chosen = conversation.contents.uncensored
      ? uncensoredModel(conversation.contents)
      : (conversation.contents.deep ? deepModel() : replyModel(conversation.contents))
    global.logger?.info(`[GEMINI]: Inherited model directive "${threadDirective}" from reply thread; using ${chosen}`)
  } else if (decision) {
    if (decision.needsDeep && deepModel() && !edit && decision.intent === 'chat') {
      conversation.contents.deep = true
      global.logger?.info(`[GEMINI-DECISION]: Deep reasoning/creative request detected (p=${decision.deepProb.toFixed(2)}); routing directly to ${deepModel()}`)
      await tools?.progress?.(DEEP_PROGRESS)
    }
  }
  return check(conversation, await runAgent(conversation.contents, tools, conversation.submits))
}

// The requester read the preview and wrote what to change. It goes back as the answer to the
// model's submit call, so the model revises its own draft with everything it already looked up.
// Gemini wants one response per call of the turn, so tools called alongside the submit (which were
// not run) are answered too.
async function revise (conversation, correction) {
  const parsed = parseModelDirective(correction)
  if (parsed.directive) correction = parsed.text || correction
  const prevGeminiModel = conversation.lastGeminiModel !== undefined
    ? conversation.lastGeminiModel
    : (conversation.contents.uncensored ? null : (conversation.contents.deep ? deepModel() : replyModel(conversation.contents)))
  conversation.contents.isRevision = true
  conversation.contents.requestText = correction
  if (mentionsMinor(correction)) {
    conversation.contents.minorTerm = true
    conversation.contents.omitMature = true
    conversation.contents.r18Maybe = false
    conversation.contents.disallowUncensoredHandover = true
  }
  conversation.contents.push({
    role: 'user',
    parts: conversation.lastCalls.map(call => ({
      functionResponse: {
        name: call.name,
        response: SUBMIT_DECLARATIONS.some(d => d.name === call.name)
          ? { result: `依頼者が下書きを確認し、次のように修正を求めています。修正した下書きを、もう一度提出してください。\n${correction}` }
          : { error: '下書きの提出と同時に呼ばれたため実行していません。必要ならもう一度呼んでください。' }
      }
    }))
  })
  const allowUncensored = conversation.contents.uncensoredR18 !== false && !conversation.contents.safetyFilter
  if (parsed.directive && applyModelDirective(conversation.contents, parsed.directive)) {
    const chosen = conversation.contents.uncensored
      ? uncensoredModel(conversation.contents)
      : (conversation.contents.deep ? deepModel() : replyModel(conversation.contents))
    global.logger?.info(`[GEMINI]: Explicit model directive "${parsed.directive}" in revision; using ${chosen}`)
  } else if (allowUncensored && !conversation.contents.minorTerm && !conversation.contents.uncensored && isUncensoredConfigured()) {
    const decision = sokudan.canDecide() ? await sokudan.classifyMentionRequest(correction) : null
    if (decision) conversation.contents.sokudanDecision = decision
    const r18 = r18Route({ request: correction, decision })
    if (r18.maybe) conversation.contents.r18Maybe = true
    if (r18.disallowHandover) conversation.contents.disallowUncensoredHandover = true
    else if (r18.maybe) conversation.contents.disallowUncensoredHandover = false
    if (r18.route) {
      conversation.contents.deep = false
      conversation.contents.uncensored = true
      conversation.contents.directUncensored = true
      conversation.contents.uncensoredR18Mode = true
      const initial = replyModel(conversation.contents)
      const fallback = uncensoredModel(conversation.contents)
      global.logger?.info(`[GEMINI]: R18 revision (${r18.why}); ${fallback} answers instead of ${initial}`)
    }
  }
  const nextGeminiModel = conversation.contents.uncensored
    ? null
    : (conversation.contents.deep ? deepModel() : replyModel(conversation.contents))
  if (nextGeminiModel && nextGeminiModel !== prevGeminiModel) {
    conversation.contents = cloneContentsWithoutThoughts(conversation.contents)
  }
  return check(conversation, await runAgent(conversation.contents, conversation.tools, conversation.submits))
}

module.exports = { THINKING_LEVELS, SERVICE_TIERS, defaultTaskConfig, resolveTaskConfig, replyTimeoutMs, flexUsable, SAFETY_SETTINGS, STRICT_SAFETY_SETTINGS, withSafetySettings, THINK_DEEPER_DECLARATION, HAND_OVER_R18_DECLARATION, isR18Text, isExplicitR18Text, r18Route, isRefusalReply, isRefusalReplyAsync, refusalKind, STORY_REQUEST_PATTERN, adaptiveThinkingLevel, compactContentsForWire, deepModel, DEFAULT_UNCENSORED_MODEL, normalizeLocalModelId, uncensoredModel, uncensoredR18Model, parseModelDirective, extractReferencedDirective, resolveReferencedDirective, rememberThreadModel, isUncensoredDirective, applyModelDirective, isLocalUncensoredUrl, uncensoredEndpoint, isUncensoredConfigured, isUncensoredUsable, checkUncensoredConnection, startUncensoredCheck, uncensoredState, ensureUncensoredModelLoaded, cleanUncensoredContent, compactUncensoredText, extractUncensoredAnswer, UNCENSORED_SAMPLING_PARAMS, readUncensoredResponse, callUncensored, REPLY_LENGTHS, DEFAULT_REPLY_LENGTH, PERSONAS, thinkingConfig, cachedPrefix, flushCachePurge, caches, purgedFor, promptVersion, lightModel, extractModel, DEFAULT_EXTRACT_MODEL, draft, revise, MAX_STEPS, isConfigured, toScheduledEvent, callGemini, geminiRequest, geminiSend, geminiStream, retryTimer, DEFAULT_GEMINI_MODEL, ENTITY_TYPES, GeminiError }
