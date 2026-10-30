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

module.exports = { trackUsage, currentUsage }
