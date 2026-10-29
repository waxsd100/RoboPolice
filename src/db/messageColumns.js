// Which channel and server a stored message belongs to, so the mention assistant can read a
// channel's history. Rows stored before these columns existed have them NULL and are never found
// by channel. Added on first use so existing deployments need no manual migration; both are
// nullable, so ADD COLUMN does not rewrite the table.
const pool = require('./clients/postgres')

const SCHEMA = [
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel_id TEXT',
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS guild_id TEXT',
  'CREATE INDEX IF NOT EXISTS messages_channel_ts ON messages (channel_id, ts DESC)'
]

let ready = null
function ensureChannelColumns () {
  if (!ready) {
    ready = (async () => {
      for (const sql of SCHEMA) await pool.query(sql)
    })().catch(e => {
      ready = null
      throw e
    })
  }
  return ready
}

module.exports = { ensureChannelColumns, SCHEMA }
