global.logger = require('../miscellaneous/logger')
const format = require('pg-format')
const pool = require('./clients/postgres')
const batch = []
global.timesSubmitted = 0
global.totalMessagesSubmitted = 0

// Messages held in memory before one batched INSERT. Anything still here is lost on an unclean
// restart, so keep it small: this bot logs one server, not thousands.
const BATCH_SIZE = 10
const MAX_PENDING = 1000

const inFlightBatches = new Set()

async function addItem (messageAsArray) {
  if (batch.length >= MAX_PENDING) batch.shift()
  batch.push(messageAsArray)
  if (batch.length >= BATCH_SIZE) {
    await submitBatch(BATCH_SIZE)
  }
}

// A batch row: [id, author_id, content, [image URLs], ts, channel_id, guild_id]
async function submitBatch (batchSize) {
  const toSubmit = batch.splice(0, batchSize)
  if (toSubmit.length === 0) return 0
  const flight = { rows: toSubmit, deleted: new Set(), updated: new Map() }
  inFlightBatches.add(flight)
  let poolClient = null
  try {
    poolClient = await pool.getPostgresClient()
    await poolClient.query('BEGIN')
    const activeRows = flight.rows.filter(row => !flight.deleted.has(row[0]))
    if (activeRows.length) {
      // A message of a server whose settings are gone (the bot just left it) is not stored, nor its images.
      await poolClient.query(format(
        `INSERT INTO messages (id, author_id, content, ts, channel_id, guild_id)
         SELECT v.id, v.author_id, v.content, v.ts::timestamptz, v.channel_id, v.guild_id FROM (VALUES %L) v(id, author_id, content, ts, channel_id, guild_id)
         WHERE v.guild_id IS NULL OR EXISTS (SELECT 1 FROM guilds g WHERE g.id = v.guild_id)
         ON CONFLICT DO NOTHING`,
        activeRows.map(([id, author, content, , ts, channel, guild]) => [id, author, content, ts, channel, guild])))
      const attachments = activeRows.flatMap(row => row[3].map((url, position) => [row[0], position, url]))
      if (attachments.length) {
        await poolClient.query(format(
          `INSERT INTO message_attachments (message_id, position, url)
           SELECT v.message_id, v.position::smallint, v.url FROM (VALUES %L) v(message_id, position, url)
           WHERE EXISTS (SELECT 1 FROM messages m WHERE m.id = v.message_id)
           ON CONFLICT DO NOTHING`,
          attachments))
      }
    }
    const pendingUpdates = new Map(flight.updated)
    flight.updated.clear()
    for (const [id, attrs] of pendingUpdates) {
      if (flight.deleted.has(id)) continue
      if ('content' in attrs) {
        await poolClient.query('UPDATE messages SET content = $1 WHERE id = $2', [attrs.content || 'None', id])
      }
      if ('imageUrls' in attrs) {
        await poolClient.query('DELETE FROM message_attachments WHERE message_id = $1', [id])
        for (const [position, url] of attrs.imageUrls.entries()) {
          await poolClient.query(
            'INSERT INTO message_attachments (message_id, position, url) SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM messages WHERE id = $1)',
            [id, position, url])
        }
      }
    }
    const deletedDuringSubmit = [...flight.deleted]
    if (deletedDuringSubmit.length) {
      await poolClient.query('DELETE FROM messages WHERE id = ANY($1)', [deletedDuringSubmit])
    }
    await poolClient.query('COMMIT')
    inFlightBatches.delete(flight)
    const lateDeletes = [...flight.deleted].filter(id => !deletedDuringSubmit.includes(id))
    if (lateDeletes.length) {
      await pool.query('DELETE FROM messages WHERE id = ANY($1)', [lateDeletes])
    }
    for (const [id, attrs] of flight.updated) {
      if (flight.deleted.has(id)) continue
      if ('content' in attrs) {
        await pool.query('UPDATE messages SET content = $1 WHERE id = $2', [attrs.content || 'None', id])
      }
      if ('imageUrls' in attrs) {
        await pool.query('DELETE FROM message_attachments WHERE message_id = $1', [id])
        for (const [position, url] of attrs.imageUrls.entries()) {
          await pool.query(
            'INSERT INTO message_attachments (message_id, position, url) SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM messages WHERE id = $1)',
            [id, position, url])
        }
      }
    }
  } catch (e) {
    if (poolClient) await poolClient.query('ROLLBACK').catch(() => {})
    const surviving = flight.rows.filter(row => !flight.deleted.has(row[0]))
    if (surviving.length && batch.length < MAX_PENDING) {
      batch.unshift(...surviving.slice(0, MAX_PENDING - batch.length))
    }
    throw e
  } finally {
    inFlightBatches.delete(flight)
    if (poolClient) poolClient.release()
  }
  global.timesSubmitted += 1
  global.totalMessagesSubmitted += toSubmit.length

  const msg = `Submitted ${toSubmit.length} messages within batch #${global.timesSubmitted} (${global.totalMessagesSubmitted} total).`
  global.logger.info(msg)
  global.webhook.generic(msg)

  return toSubmit.length
}

function findRow (messageID) {
  const queued = batch.find(m => m[0] === messageID)
  if (queued) return { row: queued, flight: null }
  for (const flight of inFlightBatches) {
    if (flight.deleted.has(messageID)) continue
    const row = flight.rows.find(m => m[0] === messageID)
    if (row) return { row, flight }
  }
  return null
}

function getMessage (messageID) {
  const found = findRow(messageID)
  if (!found) return
  const message = found.row
  return {
    id: message[0],
    author_id: message[1],
    content: message[2],
    attachment_urls: [...message[3]],
    ts: Date.parse(message[4])
  }
}

function updateMessage (messageID, changedAttrs) {
  const found = findRow(messageID)
  if (!found) return
  const { row, flight } = found
  // Both keys can be present at once (an edit that changes text and removes an image), so this
  // must not be if/else if: that silently dropped the image-removal whenever content also
  // changed on a message still sitting in the in-memory batch (not yet flushed to Postgres).
  let handled = false
  if ('content' in changedAttrs) {
    row[2] = changedAttrs.content || 'None'
    handled = true
  }
  if ('imageUrls' in changedAttrs) {
    row[3] = [...changedAttrs.imageUrls]
    handled = true
  }
  if (!handled) {
    const msg = `updateMessage called with unsupported changedAttrs: ${JSON.stringify(changedAttrs)}`
    global.logger.warn(msg)
    global.webhook.warn(msg)
    return
  }
  if (flight) {
    const prev = flight.updated.get(messageID) || {}
    flight.updated.set(messageID, { ...prev, ...changedAttrs })
  }
}

// Messages of `channelID` still waiting in memory (including uncommitted in-flight batches), newest first.
function getChannelMessages (channelID) {
  const combined = []
  const seen = new Set()
  for (const flight of inFlightBatches) {
    for (const m of flight.rows) {
      if (m[5] === channelID && !flight.deleted.has(m[0]) && !seen.has(m[0])) {
        seen.add(m[0])
        combined.push(m)
      }
    }
  }
  for (const m of batch) {
    if (m[5] === channelID && !seen.has(m[0])) {
      seen.add(m[0])
      combined.push(m)
    }
  }
  return combined
    .map(m => ({ id: m[0], author_id: m[1], content: m[2], ts: new Date(m[4]), channel_id: m[5] }))
    .reverse()
}

// Drops a message that is still waiting in memory, so a deletion reaches it before it is stored.
function removeMessage (messageID) {
  const index = batch.findIndex(m => m[0] === messageID)
  if (index !== -1) batch.splice(index, 1)
  for (const flight of inFlightBatches) {
    if (flight.rows.some(m => m[0] === messageID)) {
      flight.deleted.add(messageID)
      flight.updated.delete(messageID)
    }
  }
}

exports.getMessage = getMessage
exports.removeMessage = removeMessage
exports.evictMessage = removeMessage
exports.getChannelMessages = getChannelMessages
exports.addItem = addItem
exports.updateMessage = updateMessage
exports.submitBatch = submitBatch
