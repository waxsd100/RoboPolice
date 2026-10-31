// The AI work not answering someone right away (video summaries, emoji descriptions, stream
// blurbs, archive summaries) goes through one queue per worker, AI_BACKGROUND_CONCURRENCY jobs at a
// time (default 3). Jobs of the owner's servers (priority.js), and jobs for no server in
// particular, always start before those of other servers; within each, first come first served.
const { isOwnerGuild } = require('./priority')

const DEFAULT_CONCURRENCY = 3
const queues = { high: [], low: [] }
let active = 0

function concurrency () {
  const n = Math.floor(Number(process.env.AI_BACKGROUND_CONCURRENCY))
  return n >= 1 ? n : DEFAULT_CONCURRENCY
}

function next () {
  while (active < concurrency() && (queues.high.length || queues.low.length)) {
    const job = queues.high.shift() || queues.low.shift()
    clearTimeout(job.timer)
    active++
    Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => {
      active--
      next()
    })
  }
}

// Runs fn when its turn comes. guildID: the server the work is for, or null. maxWaitMs: give up
// (rejecting with a QueueTimeout) if it has not started by then, for work that is only worth
// doing soon.
class QueueTimeout extends Error {}

function run (guildID, fn, { maxWaitMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const lane = !guildID || isOwnerGuild(guildID) ? 'high' : 'low'
    const job = { fn, resolve, reject }
    if (maxWaitMs !== null) {
      job.timer = setTimeout(() => {
        const at = queues[lane].indexOf(job)
        if (at === -1) return
        queues[lane].splice(at, 1)
        reject(new QueueTimeout(`waited ${maxWaitMs} ms for its turn`))
      }, maxWaitMs)
    }
    queues[lane].push(job)
    next()
  })
}

function waiting () {
  return { active, high: queues.high.length, low: queues.low.length }
}

module.exports = { run, waiting, QueueTimeout }
