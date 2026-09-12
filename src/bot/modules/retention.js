const pool = require('../../db/clients/postgres')

// MESSAGE_HISTORY_DAYS is the retention window the bot promises to users in /clearmydata, /help and
// in PRIVACY.md. Nothing was enforcing it, so the promise only holds if we actually delete the rows.
// Deletion runs in batches because the messages table on a large server can hold millions of rows
// and a single unbounded DELETE would hold a long transaction open.

const SWEEP_INTERVAL_MS = 1000 * 60 * 60 // hourly; a sweep is a no-op once it has caught up
const BATCH_SIZE = 5000
const MAX_BATCHES_PER_SWEEP = 100 // 500k rows per sweep, so a first run drains over a few hours

let sweeping = false

function getRetentionDays () {
  const days = parseInt(process.env.MESSAGE_HISTORY_DAYS, 10)
  if (!Number.isInteger(days) || days <= 0) return null
  return days
}

async function sweep () {
  const days = getRetentionDays()
  if (!days || sweeping) return
  sweeping = true
  let deleted = 0
  try {
    for (let i = 0; i < MAX_BATCHES_PER_SWEEP; i++) {
      const res = await pool.query(
        'DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE ts < NOW() - ($1::int * INTERVAL \'1 day\') LIMIT $2)',
        [days, BATCH_SIZE]
      )
      deleted += res.rowCount
      if (res.rowCount < BATCH_SIZE) break
    }
    if (deleted > 0) {
      const msg = `[RETENTION]: Deleted ${deleted.toLocaleString()} message rows older than ${days} days.`
      global.logger.info(msg)
      global.webhook.generic(msg)
    }
  } catch (e) {
    global.logger.error(`[RETENTION]: Sweep failed: ${e.message}`)
  } finally {
    sweeping = false
  }
}

function start () {
  const days = getRetentionDays()
  if (!days) {
    global.logger.warn('[RETENTION]: MESSAGE_HISTORY_DAYS is unset or invalid, so stored messages will never expire. This contradicts the retention window stated in PRIVACY.md and in /clearmydata.')
    return
  }
  global.logger.startup(`[RETENTION]: Message retention is ${days} days. Sweeping every ${SWEEP_INTERVAL_MS / 60000} minutes.`)
  sweep()
  setInterval(sweep, SWEEP_INTERVAL_MS)
}

module.exports = { start, sweep, getRetentionDays }
