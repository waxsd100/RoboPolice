require('dotenv').config()

const pool = require('../db/clients/postgres')

// Deletes message rows past the retention window promised in PRIVACY.md and in /clearmydata.
//
// Two ways to run it, pick one (running both is harmless, just redundant):
//   - In-process: the bot schedules this itself on the worker owning shard 0. This is the default.
//   - Railway Cron: add a second service on this repo with start command
//       node src/miscellaneous/prune.js
//     a cron schedule, and the same PG* variables, then set PRUNE_EXTERNAL=true on the bot service
//     so it stops scheduling its own sweep.
//
// Deletion is batched: on a busy server the first run can face millions of rows, and one unbounded
// DELETE would hold a long transaction open and bloat the table.

const BATCH_SIZE = 5000
const MAX_BATCHES_PER_RUN = 200 // 1M rows per run; a backlog drains over a few runs
const SWEEP_INTERVAL_MS = 1000 * 60 * 60

let sweeping = false

function getRetentionDays () {
  const days = parseInt(process.env.MESSAGE_HISTORY_DAYS, 10)
  if (!Number.isInteger(days) || days <= 0) return null
  return days
}

async function prune () {
  const days = getRetentionDays()
  if (!days) throw new Error('MESSAGE_HISTORY_DAYS is unset or not a positive integer')
  let deleted = 0
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const res = await pool.query(
      'DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE ts < NOW() - ($1::int * INTERVAL \'1 day\') LIMIT $2)',
      [days, BATCH_SIZE]
    )
    deleted += res.rowCount
    if (res.rowCount < BATCH_SIZE) break
  }
  return { deleted, days }
}

async function sweep () {
  if (sweeping) return
  sweeping = true
  try {
    const { deleted, days } = await prune()
    if (deleted > 0) {
      const msg = `[PRUNE]: Deleted ${deleted.toLocaleString()} message rows older than ${days} days.`
      global.logger.info(msg)
      global.webhook.generic(msg)
    }
  } catch (e) {
    global.logger.error(`[PRUNE]: Sweep failed: ${e.message}`)
  } finally {
    sweeping = false
  }
}

function startScheduler () {
  if (process.env.PRUNE_EXTERNAL === 'true') {
    global.logger.info('[PRUNE]: PRUNE_EXTERNAL is set, leaving retention to the external cron job.')
    return
  }
  const days = getRetentionDays()
  if (!days) {
    global.logger.warn('[PRUNE]: MESSAGE_HISTORY_DAYS is unset, so stored messages will never expire. This contradicts the retention window stated in PRIVACY.md and in /clearmydata.')
    return
  }
  global.logger.startup(`[PRUNE]: Message retention is ${days} days, sweeping every ${SWEEP_INTERVAL_MS / 60000} minutes.`)
  sweep()
  setInterval(sweep, SWEEP_INTERVAL_MS)
}

async function main () {
  try {
    const { deleted, days } = await prune()
    console.log(`[PRUNE]: Deleted ${deleted.toLocaleString()} message rows older than ${days} days.`)
    pool.end()
    process.exit(0)
  } catch (e) {
    console.error(`[PRUNE]: ${e.message}`)
    process.exit(1)
  }
}

if (require.main === module) main()

module.exports = { prune, startScheduler, getRetentionDays }
