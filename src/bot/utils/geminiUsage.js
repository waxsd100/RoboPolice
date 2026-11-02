// Counts the Gemini requests made while handling one mention, wherever they are made (drafting,
// image generation, video summaries), so a rate limit can be traced to how many calls a request
// really needs. AsyncLocalStorage carries the counter through every await without passing it.
const { AsyncLocalStorage } = require('node:async_hooks')

const storage = new AsyncLocalStorage()

// onWait(ms) is told when a call waits before retrying, to show the requester why it is slow.
function trackUsage (fn) {
  const usage = { requests: 0, retries: 0, onWait: () => {} }
  return storage.run(usage, () => fn(usage))
}

// The counter of the mention being handled, or null outside of one.
function currentUsage () {
  return storage.getStore() || null
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

module.exports = { trackUsage, currentUsage, recordTokens, tokenCounts, logTokens }
