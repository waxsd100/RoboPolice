// Counts the Gemini requests made while handling one mention, wherever they are made (drafting,
// image generation, video summaries), so a rate limit can be traced to how many calls a request
// really needs. AsyncLocalStorage carries the counter through every await without passing it.
const { AsyncLocalStorage } = require('node:async_hooks')

const storage = new AsyncLocalStorage()

// onWait(ms) is told when a call waits before retrying, to show the requester why it is slow.
// tokens: what the calls used, from Gemini's usageMetadata (shown under a chat reply).
function trackUsage (fn) {
  const usage = { requests: 0, retries: 0, onWait: () => {}, tokens: { prompt: 0, cached: 0, output: 0, thoughts: 0 } }
  return storage.run(usage, () => fn(usage))
}

// The counter of the mention being handled, or null outside of one.
function currentUsage () {
  return storage.getStore() || null
}

// Adds a response's usageMetadata to the mention being handled, if any.
function addTokens (meta) {
  const usage = currentUsage()
  if (!usage?.tokens || !meta) return
  usage.tokens.prompt += meta.promptTokenCount || 0
  usage.tokens.cached += meta.cachedContentTokenCount || 0
  usage.tokens.output += meta.candidatesTokenCount || 0
  usage.tokens.thoughts += meta.thoughtsTokenCount || 0
}

const n = x => x.toLocaleString('en-US')

// The tokens a mention used, as Discord's small grey text (-#), or '' when none were counted or
// MENTION_TOKEN_FOOTER=false.
function tokenFooter (usage) {
  const t = usage?.tokens
  if (process.env.MENTION_TOKEN_FOOTER === 'false' || !t || !(t.prompt + t.output + t.thoughts)) return ''
  return `-# トークン: 入力 ${n(t.prompt)}（うちキャッシュ ${n(t.cached)}）・出力 ${n(t.output)}${t.thoughts ? `・思考 ${n(t.thoughts)}` : ''}（Gemini ${usage.requests} 回）`
}

module.exports = { trackUsage, currentUsage, addTokens, tokenFooter }
