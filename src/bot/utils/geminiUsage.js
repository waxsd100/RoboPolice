// Counts the Gemini requests made while handling one mention, wherever they are made (drafting,
// image generation, video summaries), so a rate limit can be traced to how many calls a request
// really needs. AsyncLocalStorage carries the counter through every await without passing it.
const { AsyncLocalStorage } = require('node:async_hooks')

const storage = new AsyncLocalStorage()

// onWait(ms) is told when a call waits before retrying, to show the requester why it is slow.
// tokens: what the calls used, from Gemini's usageMetadata (shown under a chat reply); cost: the
// same weighted by model, as counted against the user's limits (mentionQuota.js).
function trackUsage (fn) {
  const usage = { requests: 0, retries: 0, onWait: () => {}, tokens: { prompt: 0, cached: 0, output: 0, thoughts: 0 }, cost: 0, models: [], fallbacks: [] }
  return storage.run(usage, () => fn(usage))
}

// The counter of the mention being handled, or null outside of one.
function currentUsage () {
  return storage.getStore() || null
}

// Adds a response's usageMetadata (from `model`, on Flex inference or not) to the mention being
// handled, if any.
function addTokens (meta, { model = '', flex = false } = {}) {
  const usage = currentUsage()
  if (!usage?.tokens || !meta) return
  usage.cost = (usage.cost || 0) + require('./mentionQuota').costOf(meta, model, { flex })
  usage.tokens.prompt += meta.promptTokenCount || 0
  usage.tokens.cached += meta.cachedContentTokenCount || 0
  usage.tokens.output += meta.candidatesTokenCount || 0
  usage.tokens.thoughts += meta.thoughtsTokenCount || 0
}

// The model that answered a call of the reply itself, in order, once each in a row: 'gemini-3.8-flash',
// 'gemini-4-argon (flex)'.
function addModel (model, { flex = false } = {}) {
  const usage = currentUsage()
  if (!usage?.models || !model) return
  const label = flex ? `${model} (flex)` : model
  if (usage.models[usage.models.length - 1] !== label) usage.models.push(label)
}

// Something that went another way than asked (a model refused, Flex was full), to show under the reply.
function addFallback (note) {
  const usage = currentUsage()
  if (usage?.fallbacks && !usage.fallbacks.includes(note)) usage.fallbacks.push(note)
}

const n = x => x.toLocaleString('en-US')

// The tokens a mention used, as Discord's small grey text (-#), or '' when none were counted. Shown
// only in servers that turned it on (%debugfooter).
function tokenFooter (usage) {
  const t = usage?.tokens
  if (!t || !(t.prompt + t.output + t.thoughts)) return ''
  const model = usage.models?.length ? `model: ${usage.models.join(' → ')} · ` : ''
  const fallback = usage.fallbacks?.length ? ` · fallback: ${usage.fallbacks.join('; ')}` : ''
  return `-# ${model}tokens: in ${n(t.prompt)} (cached ${n(t.cached)}) · out ${n(t.output)}${t.thoughts ? ` · thinking ${n(t.thoughts)}` : ''} · ${usage.requests} Gemini call${usage.requests === 1 ? '' : 's'}${fallback}`
}

// Tokens used, by what they were used for (`purpose`), so the cost can be traced: the prompt (and how
// much of it was served from Gemini's cache, billed at a fraction), the answer, and the model's
// thinking (billed as answer). Logged once an hour, then counted again from zero.
const tokens = new Map()
const SUMMARY_EVERY_MS = 60 * 60 * 1000
let summaryTimer = null

function recordTokens (purpose, model, meta) {
  if (!meta) return
  const key = `${purpose} (${model})`
  const t = tokens.get(key) || { calls: 0, prompt: 0, cached: 0, output: 0, thoughts: 0 }
  t.calls++
  t.prompt += meta.promptTokenCount || 0
  t.cached += meta.cachedContentTokenCount || 0
  t.output += meta.candidatesTokenCount || 0
  t.thoughts += meta.thoughtsTokenCount || 0
  tokens.set(key, t)
  if (!summaryTimer && global.logger) {
    summaryTimer = setTimeout(logTokens, SUMMARY_EVERY_MS)
    summaryTimer.unref?.()
  }
}

// The counts so far: { 'purpose (model)': { calls, prompt, cached, output, thoughts } }.
function tokenCounts () {
  return Object.fromEntries(tokens)
}

function logTokens () {
  summaryTimer = null
  if (!tokens.size) return
  const lines = [...tokens].sort((a, b) => (b[1].prompt + b[1].output + b[1].thoughts) - (a[1].prompt + a[1].output + a[1].thoughts))
    .map(([key, t]) => `${key}: ${t.calls} call(s), in ${t.prompt} (cached ${t.cached}), out ${t.output}, thinking ${t.thoughts}`)
  global.logger.info(`[GEMINI]: Tokens in the last hour:\n${lines.join('\n')}`)
  tokens.clear()
}

module.exports = { trackUsage, currentUsage, addTokens, addModel, addFallback, tokenFooter, recordTokens, tokenCounts, logTokens }
