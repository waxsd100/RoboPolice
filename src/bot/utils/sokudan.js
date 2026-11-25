// Client for Google's Decisions API (`POST /v1beta/decisions`, model `gemini-decision-1`:
// $0.10/1M input tokens, $0 output tokens), a lightweight System-1 decision model (single forward
// pass, zero text generation) used for:
// 1. Mention pre-routing (intent classification, deep-reasoning detection, R18 detection, thinking level)
// 2. Soft-refusal / fade-out (朝チュン) detection on R18 / story replies
// 3. Pre-screening long replies in replyPolish to skip unnecessary Gemini rewrites when already natural
//
// Off by default unless GEMINI_DECISION_API=true; when disabled or unreachable, every helper falls
// back gracefully so existing regex / Gemini logic continues unchanged.

const prompts = require('./prompts')

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_GEMINI_DECISION_MODEL = 'gemini-decision-1'
const DECISION_RETRY_AFTER_MS = 5 * 60 * 1000
const DEFAULT_BOOL_THRESHOLD = 0.35
const DEFAULT_R18_THRESHOLD = 0.55
const DEFAULT_REFUSAL_THRESHOLD = 0.65
const DEFAULT_POLISH_SCORE_THRESHOLD = 1.0
const MAX_STATE_CHARS = 1200
const MAX_REFERENCE_CONTEXT_CHARS = 400
const MIN_REFUSAL_CHECK_CHARS = 10
const ADULT_CHANNEL_LABEL_PATTERN = /(?:^|[^a-z0-9])(?:r-?18|nsfw)(?:$|[^a-z0-9])|18禁|成人向け|アダルト|えっち|エッチ|エロ|官能|下ネタ|年齢制限/i
const CONTEXT_DEPENDENT_REQUEST_PATTERN = /続き|続編|その後|その先|それ|これ|あれ|さっき|前の|今の|もっと|さらに|そのまま|書き直|変えて/i

const decisionState = {
  usable: null,
  checkedAt: 0,
  error: null,
  model: null
}

function timeoutMs () {
  const n = Number(process.env.GEMINI_DECISION_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS
}

function boolThreshold (envName = null, fallback = DEFAULT_BOOL_THRESHOLD) {
  if (envName && process.env[envName]) {
    const custom = Number(process.env[envName])
    if (Number.isFinite(custom) && custom > 0 && custom < 1) return custom
  }
  const n = Number(process.env.GEMINI_DECISION_BOOL_THRESHOLD)
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback
}

function polishScoreThreshold () {
  const n = Number(process.env.GEMINI_DECISION_POLISH_SCORE_THRESHOLD)
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : DEFAULT_POLISH_SCORE_THRESHOLD
}

// Normalizes Discord markup and trims `text` to a concise plain string.
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

function geminiDecisionModel () {
  return (process.env.GEMINI_DECISION_MODEL || DEFAULT_GEMINI_DECISION_MODEL).trim() || DEFAULT_GEMINI_DECISION_MODEL
}

function isDecisionApiEnabled () {
  if (process.env.GEMINI_DECISION_API !== 'true') return false
  return require('./aiGateway').isGatewayConfigured()
}

function geminiDecisionUsable () {
  if (!isDecisionApiEnabled()) return false
  if (decisionState.usable === false && decisionState.checkedAt && Date.now() - decisionState.checkedAt < DECISION_RETRY_AFTER_MS) {
    return false
  }
  return true
}

function isConfigured () {
  return isDecisionApiEnabled()
}

function isUsable () {
  return geminiDecisionUsable()
}

function canDecide () {
  return geminiDecisionUsable()
}

function geminiDecisionHeaders () {
  const headers = { 'Content-Type': 'application/json', ...require('./aiGateway').gatewayAuthHeaders() }
  if (process.env.GEMINI_API_KEY) headers['x-goog-api-key'] = process.env.GEMINI_API_KEY
  if (process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS) headers['cf-aig-byok-alias'] = process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS
  return headers
}

// Sends a single System-1 decision query directly to Google's Decisions API (`POST /v1beta/decisions`).
async function callGeminiDecision (state, questions, options = {}) {
  if (!geminiDecisionUsable()) return null
  const cleaned = cleanState(state, options.maxStateChars || MAX_STATE_CHARS)
  if (!cleaned || !questions || typeof questions !== 'object' || !Object.keys(questions).length) return null
  const model = geminiDecisionModel()
  const { gatewayURL } = require('./aiGateway')
  const url = gatewayURL('google-ai-studio/v1beta/decisions')
  const timeout = options.timeoutMs || timeoutMs()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: geminiDecisionHeaders(),
      body: JSON.stringify({ model, input: cleaned, questions }),
      signal: AbortSignal.timeout(timeout)
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // 400 may be a safety block on one input; trip circuit breaker only on infrastructure/auth failures.
      if (res.status >= 500 || res.status === 429 || res.status === 401 || res.status === 403 || res.status === 404) {
        decisionState.usable = false
        decisionState.checkedAt = Date.now()
        decisionState.error = `HTTP ${res.status}`
      }
      global.logger?.debug?.(`[GEMINI-DECISION]: /v1beta/decisions returned HTTP ${res.status}: ${body.slice(0, 200)}`)
      return null
    }
    const data = await res.json()
    decisionState.usable = true
    decisionState.checkedAt = Date.now()
    decisionState.error = null
    decisionState.model = model
    if (data?.usage) {
      const meta = {
        promptTokenCount: data.usage.total_input_tokens ?? data.usage.promptTokenCount ?? 0,
        candidatesTokenCount: data.usage.total_output_tokens ?? data.usage.candidatesTokenCount ?? 0,
        cachedContentTokenCount: 0
      }
      const geminiUsage = require('./geminiUsage')
      geminiUsage.recordTokens('decision', model, meta)
      geminiUsage.addTokens(meta, { model })
      require('./geminiLoad').record(require('./mentionQuota').costOf(meta, model))
    }
    return data && typeof data.answers === 'object' ? { ...data, source: 'gemini-decision' } : null
  } catch (e) {
    decisionState.usable = false
    decisionState.checkedAt = Date.now()
    decisionState.error = e.message
    global.logger?.debug?.(`[GEMINI-DECISION]: /v1beta/decisions request failed, falling back: ${e.message}`)
    return null
  }
}

async function decideState (state, questions, options = {}) {
  return callGeminiDecision(state, questions, options)
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
  if (!canDecide()) return null
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
  const data = await decideState(state, MENTION_QUESTIONS())
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
  // null when the model did not answer this one: the caller then judges by its own pattern.
  const storyProb = Number.isFinite(storyAns?.noul) ? storyAns.noul : null
  const complexityScore = Number.isFinite(compAns?.score) ? compAns.score : null

  const r18Thresh = boolThreshold('GEMINI_DECISION_R18_THRESHOLD', DEFAULT_R18_THRESHOLD)
  const deepThresh = boolThreshold('GEMINI_DECISION_DEEP_THRESHOLD')

  return {
    intent,
    intentConfidence,
    needsDeep: deepProb >= deepThresh,
    deepProb,
    isR18: r18Prob >= r18Thresh,
    r18Prob,
    isStory: storyProb === null ? null : storyProb >= boolThreshold('GEMINI_DECISION_STORY_THRESHOLD'),
    storyProb,
    complexityScore,
    thinkingLevel: scoreToThinkingLevel(complexityScore, intent),
    source: data.source || 'gemini-decision'
  }
}

// Use Case 2b: Screens a chat reply from Gemini to detect soft refusals or fade-to-morning
// ("朝チュン") evasions on R18 requests when paraphrased wording evades regex.
async function detectRefusalReply (text, requestText = '') {
  if (!canDecide()) return { refused: false, probability: 0 }
  const cleaned = cleanState(text, MAX_STATE_CHARS)
  if ([...cleaned].length < MIN_REFUSAL_CHECK_CHARS) return { refused: false, probability: 0 }
  const reqClean = cleanState(requestText, 300)
  const replyClean = reqClean ? cleanState(text, MAX_STATE_CHARS - reqClean.length - 30) : cleaned
  const state = reqClean
    ? `依頼メッセージ:\n${reqClean}\n\nBOTの返事:\n${replyClean}`
    : cleaned

  const data = await decideState(state, REFUSAL_QUESTIONS())
  const prob = Number.isFinite(data?.answers?.refusal?.noul) ? data.answers.refusal.noul : 0
  const threshold = boolThreshold('GEMINI_DECISION_REFUSAL_THRESHOLD', DEFAULT_REFUSAL_THRESHOLD)
  return {
    refused: prob >= threshold,
    probability: prob
  }
}

// Use Case 3: Evaluates whether a >= 250-char chat reply actually sounds stiff / AI-translated
// before spending a Gemini round-trip in replyPolish.js.
// Returns `null` when Gemini Decisions API is disabled or unreachable so replyPolish falls back to
// its existing behavior.
async function detectStiffAiReply (text) {
  if (!canDecide()) return null
  const cleaned = cleanState(text, MAX_STATE_CHARS)
  if (!cleaned) return null

  const data = await decideState(cleaned, STIFFNESS_QUESTIONS())
  if (!data?.answers) return null

  const score = Number.isFinite(data.answers.stiffness?.score) ? data.answers.stiffness.score : null
  const prob = Number.isFinite(data.answers.needs_rewrite?.noul) ? data.answers.needs_rewrite.noul : null
  if (score === null && prob === null) return null

  const threshold = boolThreshold('GEMINI_DECISION_POLISH_THRESHOLD')
  const scoreThresh = polishScoreThreshold()
  const needsPolish = (prob !== null && prob >= threshold) || (score !== null && score >= scoreThresh)

  return {
    needsPolish,
    score,
    probability: prob
  }
}

module.exports = {
  isConfigured,
  isUsable,
  canDecide,
  geminiDecisionModel,
  isDecisionApiEnabled,
  geminiDecisionUsable,
  decisionState,
  cleanState,
  boolThreshold,
  polishScoreThreshold,
  callGeminiDecision,
  decideState,
  scoreToThinkingLevel,
  classifyMentionRequest,
  detectRefusalReply,
  detectStiffAiReply
}
