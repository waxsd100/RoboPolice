// Client for GeneLab/sokudan-ja-310m (`sokudan serve`), a lightweight Japanese System-1 decision
// model (~310M parameters, single forward pass, zero text generation) used for:
// 1. Mention pre-routing (intent classification, deep-reasoning detection, R18 detection, thinking level)
// 2. Prompt injection screening and soft-refusal / fade-out (朝チュン) detection
// 3. Pre-screening long replies in replyPolish to skip unnecessary Gemini rewrites when already natural
//
// When SOKUDAN_URL is unset or the sidecar container is unreachable, every helper falls back
// gracefully so existing regex / Gemini logic continues unchanged.

const prompts = require('./prompts')

const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_HEALTH_TIMEOUT_MS = 5000
const DEFAULT_RETRY_INTERVAL_MS = 30 * 1000
// GeneLab/sokudan-ja-310m under-predicts P(true) on `noul` (mean ~0.20 vs 0.30 base rate while
// AUROC is ~0.88-0.91); 0.35 gives strong recall without sacrificing precision.
const DEFAULT_BOOL_THRESHOLD = 0.35
const DEFAULT_R18_THRESHOLD = 0.55
const DEFAULT_REFUSAL_THRESHOLD = 0.65
const DEFAULT_POLISH_SCORE_THRESHOLD = 1.0
const MAX_STATE_CHARS = 1200
const MAX_REFERENCE_CONTEXT_CHARS = 400
const MIN_INJECTION_CHECK_CHARS = 12
const MIN_REFUSAL_CHECK_CHARS = 10
const ADULT_CHANNEL_LABEL_PATTERN = /(?:^|[^a-z0-9])(?:r-?18|nsfw)(?:$|[^a-z0-9])|18禁|成人向け|アダルト|えっち|エッチ|エロ|官能|下ネタ|年齢制限/i
const CONTEXT_DEPENDENT_REQUEST_PATTERN = /続き|続編|その後|その先|それ|これ|あれ|さっき|前の|今の|もっと|さらに|そのまま|書き直|変えて/i

const sokudanState = {
  usable: null,
  url: null,
  checkedAt: 0,
  error: null,
  model: null
}

function timeoutMs () {
  const n = Number(process.env.SOKUDAN_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS
}

function boolThreshold (envName = null, fallback = DEFAULT_BOOL_THRESHOLD) {
  if (envName && process.env[envName]) {
    const custom = Number(process.env[envName])
    if (Number.isFinite(custom) && custom > 0 && custom < 1) return custom
  }
  const n = Number(process.env.SOKUDAN_BOOL_THRESHOLD)
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback
}

function polishScoreThreshold () {
  const n = Number(process.env.SOKUDAN_POLISH_SCORE_THRESHOLD)
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : DEFAULT_POLISH_SCORE_THRESHOLD
}

function sokudanEndpoint () {
  const raw = String(process.env.SOKUDAN_URL || '').trim()
  if (!raw) return null
  const withProto = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  const baseUrl = withProto
    .replace(/\/+$/, '')
    .replace(/\/v1\/systemone$/i, '')
    .replace(/\/v1$/i, '')
    .replace(/\/health$/i, '')
  return {
    baseUrl,
    systemOneUrl: `${baseUrl}/v1/systemone`,
    healthUrl: `${baseUrl}/health`
  }
}

function isConfigured () {
  return !!sokudanEndpoint()
}

function isUsable () {
  const endpoint = sokudanEndpoint()
  if (!endpoint) return false
  if (sokudanState.url === endpoint.baseUrl && sokudanState.usable === false) {
    if (sokudanState.checkedAt && Date.now() - sokudanState.checkedAt < DEFAULT_RETRY_INTERVAL_MS) {
      return false
    }
  }
  return true
}

function sokudanHeaders () {
  const headers = { 'Content-Type': 'application/json' }
  const key = String(process.env.SOKUDAN_API_KEY || '').trim()
  if (key) headers.Authorization = `Bearer ${key}`
  return headers
}

// Normalizes Discord markup and trims `text` to a concise plain string (GeneLab/sokudan-ja-310m
// expects a plain string `state` rather than a JSON object).
function cleanState (text, maxChars = MAX_STATE_CHARS) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/<a?:(\w{2,32}):\d+>/g, ':$1:')
    .replace(/<@!?\d+>/g, '@user')
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars)
}

async function checkConnection () {
  const endpoint = sokudanEndpoint()
  if (!endpoint) return false
  sokudanState.url = endpoint.baseUrl
  try {
    const res = await fetch(endpoint.healthUrl, {
      method: 'GET',
      headers: sokudanHeaders(),
      signal: AbortSignal.timeout(DEFAULT_HEALTH_TIMEOUT_MS)
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
    const data = await res.json().catch(() => ({}))
    sokudanState.usable = true
    sokudanState.checkedAt = Date.now()
    sokudanState.error = null
    sokudanState.model = data?.model || 'GeneLab/sokudan-ja-310m'
    global.logger?.info(`[SOKUDAN]: Connected to ${endpoint.baseUrl} (model: ${sokudanState.model}, backend: ${data?.backend || 'unknown'}, device: ${data?.device || 'unknown'})`)
    return true
  } catch (e) {
    sokudanState.usable = false
    sokudanState.checkedAt = Date.now()
    sokudanState.error = e.message
    global.logger?.warn(`[SOKUDAN]: Health check failed for ${endpoint.baseUrl}: ${e.message}`)
    return false
  }
}

function startSokudanCheck () {
  if (!isConfigured()) return
  checkConnection().catch(() => {})
}

// Sends a single System-1 decision query to `POST /v1/systemone`.
// `state` MUST be a plain string; `questions` maps question IDs to `{ type, instructions, criteria }`.
async function systemOne (state, questions, options = {}) {
  const endpoint = sokudanEndpoint()
  if (!endpoint || !isUsable()) return null
  const cleaned = cleanState(state, options.maxStateChars || MAX_STATE_CHARS)
  if (!cleaned || !questions || typeof questions !== 'object' || !Object.keys(questions).length) return null
  try {
    const res = await fetch(endpoint.systemOneUrl, {
      method: 'POST',
      headers: sokudanHeaders(),
      body: JSON.stringify({ state: cleaned, questions }),
      signal: AbortSignal.timeout(options.timeoutMs || timeoutMs())
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (res.status >= 500 || res.status === 429 || res.status === 401 || res.status === 403 || res.status === 404) {
        sokudanState.url = endpoint.baseUrl
        sokudanState.usable = false
        sokudanState.checkedAt = Date.now()
        sokudanState.error = `HTTP ${res.status}`
      }
      global.logger?.warn(`[SOKUDAN]: /v1/systemone returned HTTP ${res.status}: ${body.slice(0, 200)}`)
      return null
    }
    const data = await res.json()
    sokudanState.url = endpoint.baseUrl
    sokudanState.usable = true
    sokudanState.checkedAt = Date.now()
    sokudanState.error = null
    return data && typeof data.answers === 'object' ? data : null
  } catch (e) {
    sokudanState.url = endpoint.baseUrl
    sokudanState.usable = false
    sokudanState.checkedAt = Date.now()
    sokudanState.error = e.message
    global.logger?.debug?.(`[SOKUDAN]: /v1/systemone request failed, falling back: ${e.message}`)
    return null
  }
}

function scoreToThinkingLevel (score, intent) {
  if (intent === 'event' || intent === 'forum') return 'high'
  if (!Number.isFinite(score)) return null
  if (score < 0.45) return 'minimal'
  if (score < 1.05) return 'low'
  if (score < 1.55) return 'medium'
  return 'high'
}

// What each use asks, from prompts/sokudan/*.md (read once, then kept by prompts.js).
const MENTION_QUESTIONS = () => prompts.questions('mention', {
  intent: { type: 'choice', choices: ['event', 'chat', 'forum'] },
  needs_deep: { type: 'noul' },
  is_r18: { type: 'noul' },
  is_story: { type: 'noul' },
  complexity: { type: 'score', levels: 3 }
})
const INJECTION_QUESTIONS = () => prompts.questions('injection', { injection: { type: 'noul' } })
const REFUSAL_QUESTIONS = () => prompts.questions('refusal', { refusal: { type: 'noul' } })
const STIFFNESS_QUESTIONS = () => prompts.questions('stiffness', {
  stiffness: { type: 'score', levels: 3 },
  needs_rewrite: { type: 'noul' }
})

// Use Case 1: Pre-routes a mention request in a single forward pass:
// - intent ('event' | 'chat' | 'forum')
// - needsDeep (whether the request asks for a story/novel, long explanation, or complex reasoning)
// - isR18 (whether the request asks for adult / R18 / erotic content, including euphemistic wording)
// - isStory (whether the request asks for a story or other fiction to be written, or continued)
// - complexityScore (0..2) and thinkingLevel ('minimal' | 'low' | 'medium' | 'high')
async function classifyMentionRequest (request, referencedText = '', channelContext = '') {
  if (!isUsable()) return null
  const reqClean = cleanState(request, 900)
  if (!reqClean) return null
  const rawChan = cleanState(channelContext, 120)
  const chanClean = ADULT_CHANNEL_LABEL_PATTERN.test(rawChan) ? '' : rawChan
  const includeRef = referencedText && ([...reqClean].length <= 40 || CONTEXT_DEPENDENT_REQUEST_PATTERN.test(reqClean))
  const rawRef = includeRef ? cleanState(referencedText, Number.MAX_SAFE_INTEGER) : ''
  const refBudget = Math.max(120, Math.min(MAX_REFERENCE_CONTEXT_CHARS, MAX_STATE_CHARS - reqClean.length - chanClean.length - 40))
  const refClean = rawRef.length > refBudget ? rawRef.slice(-refBudget).trimStart() : rawRef
  const sections = [
    chanClean ? `チャンネル: ${chanClean}` : '',
    refClean ? `返信先の会話:\n${refClean}` : ''
  ].filter(Boolean)
  const state = sections.length
    ? `${sections.join('\n\n')}\n\n依頼メッセージ:\n${reqClean}`
    : reqClean

  // The questions are in prompts/sokudan/mention.md (with the notes on how to write them).
  const data = await systemOne(state, MENTION_QUESTIONS())
  if (!data?.answers) return null

  const intentAns = data.answers.intent
  const deepAns = data.answers.needs_deep
  const r18Ans = data.answers.is_r18
  const storyAns = data.answers.is_story
  const compAns = data.answers.complexity

  const intent = typeof intentAns?.choice === 'string' ? intentAns.choice : 'chat'
  const intentConfidence = Number.isFinite(intentAns?.confidence) ? intentAns.confidence : 0
  const deepProb = Number.isFinite(deepAns?.noul) ? deepAns.noul : 0
  const r18Prob = Number.isFinite(r18Ans?.noul) ? r18Ans.noul : 0
  // null when the sidecar did not answer this one: the caller then judges by its own pattern.
  const storyProb = Number.isFinite(storyAns?.noul) ? storyAns.noul : null
  const complexityScore = Number.isFinite(compAns?.score) ? compAns.score : null

  const r18Thresh = boolThreshold('SOKUDAN_R18_THRESHOLD', DEFAULT_R18_THRESHOLD)
  const deepThresh = boolThreshold('SOKUDAN_DEEP_THRESHOLD')

  return {
    intent,
    intentConfidence,
    needsDeep: deepProb >= deepThresh,
    deepProb,
    isR18: r18Prob >= r18Thresh,
    r18Prob,
    isStory: storyProb === null ? null : storyProb >= boolThreshold('SOKUDAN_STORY_THRESHOLD'),
    storyProb,
    complexityScore,
    thinkingLevel: scoreToThinkingLevel(complexityScore, intent)
  }
}

// Use Case 2a: Screens untrusted text for prompt injection / jailbreak attempts that evade regex.
async function detectInjection (text) {
  if (!isUsable()) return { detected: false, probability: 0 }
  const raw = cleanState(text, Number.MAX_SAFE_INTEGER)
  const half = Math.floor(MAX_STATE_CHARS / 2)
  const cleaned = raw.length > MAX_STATE_CHARS
    ? `${raw.slice(0, half)}\n${raw.slice(-half)}`
    : raw
  if ([...cleaned].length < MIN_INJECTION_CHECK_CHARS) return { detected: false, probability: 0 }

  const data = await systemOne(cleaned, INJECTION_QUESTIONS(), { maxStateChars: MAX_STATE_CHARS + 2 })
  const prob = Number.isFinite(data?.answers?.injection?.noul) ? data.answers.injection.noul : 0
  const threshold = boolThreshold('SOKUDAN_INJECTION_THRESHOLD')
  return {
    detected: prob >= threshold,
    probability: prob
  }
}

// Use Case 2b: Screens a chat reply from Gemini to detect soft refusals or fade-to-morning
// ("朝チュン") evasions on R18 requests when paraphrased wording evades regex.
async function detectRefusalReply (text, requestText = '') {
  if (!isUsable()) return { refused: false, probability: 0 }
  const cleaned = cleanState(text, MAX_STATE_CHARS)
  if ([...cleaned].length < MIN_REFUSAL_CHECK_CHARS) return { refused: false, probability: 0 }
  const reqClean = cleanState(requestText, 300)
  const replyClean = reqClean ? cleanState(text, MAX_STATE_CHARS - reqClean.length - 30) : cleaned
  const state = reqClean
    ? `依頼メッセージ:\n${reqClean}\n\nBOTの返事:\n${replyClean}`
    : cleaned

  const data = await systemOne(state, REFUSAL_QUESTIONS())
  const prob = Number.isFinite(data?.answers?.refusal?.noul) ? data.answers.refusal.noul : 0
  const threshold = boolThreshold('SOKUDAN_REFUSAL_THRESHOLD', DEFAULT_REFUSAL_THRESHOLD)
  return {
    refused: prob >= threshold,
    probability: prob
  }
}

// Use Case 3: Evaluates whether a >= 250-char chat reply actually sounds stiff / AI-translated
// before spending a Gemini round-trip in replyPolish.js.
// Returns `null` when Sokudan is unconfigured or unreachable so replyPolish falls back to its
// existing behavior.
async function detectStiffAiReply (text) {
  if (!isUsable()) return null
  const cleaned = cleanState(text, MAX_STATE_CHARS)
  if (!cleaned) return null

  const data = await systemOne(cleaned, STIFFNESS_QUESTIONS())
  if (!data?.answers) return null

  const score = Number.isFinite(data.answers.stiffness?.score) ? data.answers.stiffness.score : null
  const prob = Number.isFinite(data.answers.needs_rewrite?.noul) ? data.answers.needs_rewrite.noul : null
  if (score === null && prob === null) return null

  const threshold = boolThreshold('SOKUDAN_POLISH_THRESHOLD')
  const scoreThresh = polishScoreThreshold()
  const needsPolish = (prob !== null && prob >= threshold) || (score !== null && score >= scoreThresh)

  return {
    needsPolish,
    score,
    probability: prob
  }
}

module.exports = {
  sokudanEndpoint,
  isConfigured,
  isUsable,
  sokudanState,
  checkConnection,
  startSokudanCheck,
  cleanState,
  boolThreshold,
  polishScoreThreshold,
  systemOne,
  scoreToThinkingLevel,
  classifyMentionRequest,
  detectInjection,
  detectRefusalReply,
  detectStiffAiReply
}
